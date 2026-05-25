import type { AgentEvent, RunResult } from "@5x-ai/5x-cli";

/** Mutable state for Cursor Agent stream-json mapping. */
export interface CursorAgentMapperState {
	toolNamesByCallId: Map<string, string>;
	finalAssistantText: string;
	accumulatedText: string;
	sessionId?: string;
}

export interface CursorAgentMapperOptions {
	/** When true (default), skip duplicate assistant flushes per Cursor partial docs. */
	partialMode?: boolean;
	sessionIdFallback?: string;
}

export function createMapperState(): CursorAgentMapperState {
	return {
		toolNamesByCallId: new Map(),
		finalAssistantText: "",
		accumulatedText: "",
	};
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

function getString(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

function assistantText(line: Record<string, unknown>): string {
	const message = asRecord(line.message);
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const rec = asRecord(block);
			return rec ? (getString(rec, "text") ?? "") : "";
		})
		.join("");
}

function normalizeToolName(raw: string): string {
	if (raw.endsWith("ToolCall")) {
		const base = raw.slice(0, -"ToolCall".length);
		if (base.length === 0) return raw.toLowerCase();
		return base.charAt(0).toLowerCase() + base.slice(1);
	}
	return raw;
}

function truncate(text: string, max = 120): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function summarizeToolArgs(tool: string, args: Record<string, unknown>): string {
	const path = getString(args, "path");
	if (path && (tool === "read" || tool === "write" || tool === "edit")) {
		return path;
	}

	const command = getString(args, "command") ?? getString(args, "cmd");
	if (command) return truncate(command);

	const name = getString(args, "name");
	if (name) return name;

	const argumentsRaw = args.arguments;
	if (typeof argumentsRaw === "string" && argumentsRaw !== "") {
		return truncate(argumentsRaw);
	}

	try {
		return truncate(JSON.stringify(args));
	} catch {
		return "[unserializable args]";
	}
}

function parseTypedToolCall(
	toolCall: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | undefined {
	for (const [key, value] of Object.entries(toolCall)) {
		if (key === "function") continue;
		const typed = asRecord(value);
		if (!typed) continue;
		const args = asRecord(typed.args) ?? {};
		return { tool: normalizeToolName(key), args };
	}

	const fn = asRecord(toolCall.function);
	if (fn) {
		const name = getString(fn, "name") ?? "unknown_tool";
		const argsRaw = fn.arguments;
		if (typeof argsRaw === "string") {
			try {
				const parsed = JSON.parse(argsRaw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return { tool: name, args: parsed as Record<string, unknown> };
				}
			} catch {
				return { tool: name, args: { arguments: argsRaw } };
			}
		}
		return { tool: name, args: {} };
	}

	return undefined;
}

function toolCallOutput(
	toolCall: Record<string, unknown>,
	tool: string,
): { output: string; error?: boolean } {
	for (const [key, value] of Object.entries(toolCall)) {
		if (key === "function") continue;
		const typed = asRecord(value);
		if (!typed) continue;
		const result = asRecord(typed.result);
		if (!result) continue;

		const success = asRecord(result.success);
		if (success) {
			const content = getString(success, "content");
			if (content !== undefined) return { output: content };
			try {
				return { output: JSON.stringify(success) };
			} catch {
				return { output: "[unserializable success result]" };
			}
		}

		const error = asRecord(result.error);
		if (error) {
			const msg =
				getString(error, "message") ??
				getString(error, "error") ??
				`${tool} failed`;
			return { output: msg, error: true };
		}
	}

	const fn = asRecord(toolCall.function);
	if (fn) {
		const output = fn.result ?? fn.output;
		if (typeof output === "string") return { output };
		if (output !== undefined) {
			try {
				return { output: JSON.stringify(output) };
			} catch {
				return { output: "[unserializable function result]" };
			}
		}
	}

	return { output: "" };
}

function mapAssistantLine(
	line: Record<string, unknown>,
	state: CursorAgentMapperState,
	options?: CursorAgentMapperOptions,
): AgentEvent | undefined {
	const partialMode = options?.partialMode !== false;
	const hasTimestamp = typeof line.timestamp_ms === "number";
	const hasModelCallId =
		line.model_call_id !== undefined && line.model_call_id !== null;

	if (partialMode) {
		if (hasTimestamp && hasModelCallId) {
			return undefined;
		}
		if (hasTimestamp && !hasModelCallId) {
			const delta = assistantText(line);
			if (delta === "") return undefined;
			state.accumulatedText += delta;
			state.finalAssistantText = state.accumulatedText;
			return { type: "text", delta };
		}
		if (!hasTimestamp && !hasModelCallId) {
			return undefined;
		}
	}

	const text = assistantText(line);
	if (text === "") return undefined;
	state.accumulatedText += text;
	state.finalAssistantText = state.accumulatedText;
	return { type: "text", delta: text };
}

function mapToolCallLine(
	line: Record<string, unknown>,
	state: CursorAgentMapperState,
): AgentEvent | undefined {
	const subtype = getString(line, "subtype");
	const callId = getString(line, "call_id");
	const toolCall = asRecord(line.tool_call);
	if (!toolCall) return undefined;

	const parsed = parseTypedToolCall(toolCall);
	if (!parsed) return undefined;

	if (subtype === "started") {
		if (callId) {
			state.toolNamesByCallId.set(callId, parsed.tool);
		}
		return {
			type: "tool_start",
			tool: parsed.tool,
			input_summary: summarizeToolArgs(parsed.tool, parsed.args),
		};
	}

	if (subtype === "completed") {
		const tool =
			(callId && state.toolNamesByCallId.get(callId)) ?? parsed.tool;
		if (callId) {
			state.toolNamesByCallId.delete(callId);
		}
		const { output, error } = toolCallOutput(toolCall, parsed.tool);
		return {
			type: "tool_end",
			tool,
			output,
			...(error ? { error: true as const } : {}),
		};
	}

	return undefined;
}

function parseResultLine(
	line: Record<string, unknown>,
	state: CursorAgentMapperState,
	options?: CursorAgentMapperOptions,
): AgentEvent | AgentEvent[] {
	const isError = line.is_error === true || getString(line, "subtype") === "error";

	if (isError) {
		const msg =
			getString(line, "error") ??
			getString(line, "message") ??
			(typeof line.result === "string" ? line.result : undefined) ??
			"Cursor Agent returned an error result";
		return { type: "error", message: msg };
	}

	const text =
		(typeof line.result === "string" ? line.result : undefined) ??
		state.finalAssistantText ??
		"";

	const sessionId =
		getString(line, "session_id") ??
		state.sessionId ??
		options?.sessionIdFallback ??
		"";

	const durationRaw = line.duration_ms ?? line.durationMs;
	const durationMs =
		typeof durationRaw === "number"
			? durationRaw
			: typeof durationRaw === "string"
				? Number.parseInt(durationRaw, 10) || 0
				: 0;

	const runResult: RunResult = {
		text,
		sessionId,
		tokens: { in: 0, out: 0 },
		durationMs,
	};

	return [
		{ type: "usage", tokens: { in: 0, out: 0 } },
		{ type: "done", result: runResult },
	];
}

/**
 * Map one parsed NDJSON line from Cursor Agent stdout to canonical `AgentEvent`(s).
 */
export function mapCursorAgentLine(
	line: Record<string, unknown>,
	state: CursorAgentMapperState,
	options?: CursorAgentMapperOptions,
): AgentEvent | AgentEvent[] | undefined {
	const t = getString(line, "type");
	if (!t) return undefined;

	if (t === "system") {
		const sessionId = getString(line, "session_id");
		if (sessionId) state.sessionId = sessionId;
		return undefined;
	}

	if (t === "user") {
		const sessionId = getString(line, "session_id");
		if (sessionId) state.sessionId = sessionId;
		return undefined;
	}

	if (t === "assistant") {
		const sessionId = getString(line, "session_id");
		if (sessionId) state.sessionId = sessionId;
		return mapAssistantLine(line, state, options);
	}

	if (t === "tool_call") {
		const sessionId = getString(line, "session_id");
		if (sessionId) state.sessionId = sessionId;
		return mapToolCallLine(line, state);
	}

	if (t === "result") {
		const sessionId = getString(line, "session_id");
		if (sessionId) state.sessionId = sessionId;
		return parseResultLine(line, state, options);
	}

	return undefined;
}

export { summarizeToolArgs as summarizeCursorToolArgs };
