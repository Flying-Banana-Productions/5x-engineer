import type { AgentEvent, RunResult } from "@5x-ai/5x-cli";

/** Mutable state for correlating tool_use ↔ tool_result across NDJSON lines. */
export interface ClaudeCodeMapperState {
	pendingTools: Map<string, string>;
	accumulatedText: string;
}

export function createMapperState(): ClaudeCodeMapperState {
	return {
		pendingTools: new Map(),
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

/**
 * Short human-readable summary of tool input for `tool_start.input_summary`.
 */
export function summarizeToolInput(
	tool: string,
	input: Record<string, unknown>,
): string {
	const name = tool.toLowerCase();

	const pathLike =
		getString(input, "file_path") ??
		getString(input, "path") ??
		getString(input, "file") ??
		getString(input, "target_file");
	if (
		name === "read" ||
		name === "write" ||
		name === "edit" ||
		name === "multiedit"
	) {
		if (pathLike) return pathLike;
	}

	if (name === "bash" || name === "shell") {
		const cmd = getString(input, "command") ?? getString(input, "cmd");
		if (cmd) {
			return cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd;
		}
	}

	if (name === "glob") {
		const pat = getString(input, "pattern") ?? getString(input, "glob_pattern");
		if (pat) return pat;
	}

	if (name === "grep") {
		const pat = getString(input, "pattern") ?? getString(input, "regex");
		if (pat) return pat;
	}

	try {
		return JSON.stringify(input);
	} catch {
		return "[unserializable input]";
	}
}

function mapStreamEvent(line: Record<string, unknown>): AgentEvent | undefined {
	const ev = asRecord(line.event);
	if (!ev) return undefined;

	// Direct delta on event (some CLI shapes)
	const deltaDirect = asRecord(ev.delta);
	if (deltaDirect) {
		const dType = getString(deltaDirect, "type");
		const text =
			getString(deltaDirect, "text") ?? getString(deltaDirect, "thinking");
		if (dType === "text_delta" && text !== undefined) {
			return { type: "text", delta: text };
		}
		if (dType === "thinking_delta" && text !== undefined) {
			return { type: "reasoning", delta: text };
		}
	}

	// content_block_delta wrapper
	if (getString(ev, "type") === "content_block_delta") {
		const inner = asRecord(ev.delta);
		if (inner) {
			const dType = getString(inner, "type");
			const text = getString(inner, "text") ?? getString(inner, "thinking");
			if (dType === "text_delta" && text !== undefined) {
				return { type: "text", delta: text };
			}
			if (dType === "thinking_delta" && text !== undefined) {
				return { type: "reasoning", delta: text };
			}
		}
	}

	return undefined;
}

function contentBlocks(msg: Record<string, unknown>): unknown[] {
	const message = asRecord(msg.message);
	const raw = message?.content ?? msg.content ?? msg.message;
	if (Array.isArray(raw)) return raw;
	return [];
}

function mapAssistantLine(
	line: Record<string, unknown>,
	state: ClaudeCodeMapperState,
): AgentEvent[] {
	const blocks = contentBlocks(line);
	const out: AgentEvent[] = [];
	for (const b of blocks) {
		const block = asRecord(b);
		if (!block || getString(block, "type") !== "tool_use") continue;
		const id = getString(block, "id");
		const name = getString(block, "name") ?? "unknown_tool";
		const inputObj = asRecord(block.input) ?? {};
		if (id) {
			state.pendingTools.set(id, name);
		}
		out.push({
			type: "tool_start",
			tool: name,
			input_summary: summarizeToolInput(name, inputObj),
		});
	}
	return out;
}

function mapUserLine(
	line: Record<string, unknown>,
	state: ClaudeCodeMapperState,
): AgentEvent[] {
	const blocks = contentBlocks(line);
	const out: AgentEvent[] = [];
	for (const b of blocks) {
		const block = asRecord(b);
		if (!block || getString(block, "type") !== "tool_result") continue;
		const toolUseId = getString(block, "tool_use_id");
		const tool =
			(toolUseId && state.pendingTools.get(toolUseId)) ?? "unknown_tool";
		if (toolUseId) {
			state.pendingTools.delete(toolUseId);
		}
		let outputText = "";
		const content = block.content;
		if (typeof content === "string") {
			outputText = content;
		} else if (Array.isArray(content)) {
			outputText = content
				.map((c) => {
					if (typeof c === "string") return c;
					const rec = asRecord(c);
					return rec ? (getString(rec, "text") ?? "") : "";
				})
				.join("");
		}
		const isError = block.is_error === true;
		out.push({
			type: "tool_end",
			tool,
			output: outputText,
			...(isError ? { error: true as const } : {}),
		});
	}
	return out;
}

function parseUsage(obj: Record<string, unknown> | undefined): {
	in: number;
	out: number;
} {
	if (!obj) return { in: 0, out: 0 };
	const u = asRecord(obj.usage) ?? obj;
	const inn =
		typeof u.input_tokens === "number"
			? u.input_tokens
			: typeof u.input === "number"
				? u.input
				: 0;
	const outt =
		typeof u.output_tokens === "number"
			? u.output_tokens
			: typeof u.output === "number"
				? u.output
				: 0;
	return { in: inn, out: outt };
}

function parseResultLine(
	line: Record<string, unknown>,
	_sessionIdFallback: string,
): AgentEvent {
	const isError =
		line.is_error === true ||
		getString(line, "subtype") === "error" ||
		line.error === true;

	if (isError) {
		const msg =
			getString(line, "error") ??
			getString(line, "message") ??
			(typeof line.result === "string" ? line.result : undefined) ??
			"Claude Code returned an error result";
		return { type: "error", message: msg };
	}

	const text =
		(typeof line.result === "string" ? line.result : undefined) ??
		getString(line, "text") ??
		"";

	const structured =
		line.structured_output !== undefined ? line.structured_output : undefined;

	const sessionId =
		getString(line, "session_id") ??
		getString(line, "sessionId") ??
		_sessionIdFallback;

	const usage = parseUsage(line);
	const costRaw = line.total_cost_usd ?? line.cost_usd;
	const costUsd = typeof costRaw === "number" ? costRaw : undefined;

	const durationRaw = line.duration_ms ?? line.durationMs;
	const durationMs =
		typeof durationRaw === "number"
			? durationRaw
			: typeof durationRaw === "string"
				? Number.parseInt(durationRaw, 10) || 0
				: 0;

	const runResult: RunResult = {
		text,
		...(structured !== undefined ? { structured } : {}),
		sessionId,
		tokens: usage,
		...(costUsd !== undefined ? { costUsd } : {}),
		durationMs,
	};

	return { type: "done", result: runResult };
}

/**
 * Map one parsed NDJSON object from Claude Code stdout to canonical `AgentEvent`(s).
 */
export function mapNdjsonLine(
	line: Record<string, unknown>,
	state: ClaudeCodeMapperState,
	options?: { sessionIdFallback?: string },
): AgentEvent | AgentEvent[] | undefined {
	const t = getString(line, "type");
	if (!t) return undefined;

	if (t === "system") {
		return undefined;
	}

	if (t === "rate_limit_event") {
		return undefined;
	}

	if (t === "stream_event") {
		const ev = mapStreamEvent(line);
		if (ev?.type === "text") {
			state.accumulatedText += ev.delta;
		}
		return ev;
	}

	if (t === "assistant") {
		const events = mapAssistantLine(line, state);
		if (events.length === 0) return undefined;
		if (events.length === 1) {
			const first = events[0];
			return first !== undefined ? first : undefined;
		}
		return events;
	}

	if (t === "user") {
		const events = mapUserLine(line, state);
		if (events.length === 0) return undefined;
		if (events.length === 1) {
			const first = events[0];
			return first !== undefined ? first : undefined;
		}
		return events;
	}

	if (t === "result") {
		const fallback = options?.sessionIdFallback ?? "";
		return parseResultLine(line, fallback);
	}

	return undefined;
}
