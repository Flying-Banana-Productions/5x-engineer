import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
	type EscalationEvent,
	type EscalationResponse,
	escalationGate as headlessEscalationGate,
	phaseGate as headlessPhaseGate,
	resumeGate as headlessResumeGate,
	type PhaseSummary,
} from "../gates/human.js";
import type { TuiController } from "./controller.js";

export const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;

export interface TuiGateOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

function normalize(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parsePhaseDecision(
	text: string,
): "continue" | "review" | "abort" | null {
	const value = normalize(text);
	if (value === "c" || value === "continue") return "continue";
	if (value === "r" || value === "review") return "review";
	if (value === "q" || value === "abort") return "abort";
	return null;
}

function parseEscalationDecision(
	text: string,
):
	| { action: "continue"; guidance?: string }
	| { action: "approve" | "abort" }
	| null {
	const trimmed = text.trim();
	const value = normalize(trimmed);

	if (value === "o" || value === "approve" || value === "override") {
		return { action: "approve" };
	}
	if (value === "q" || value === "abort") {
		return { action: "abort" };
	}
	if (value === "f" || value === "fix" || value === "continue") {
		return { action: "continue" };
	}

	const continueMatch = trimmed.match(/^continue\s*[:-]?\s*(.+)$/i);
	if (continueMatch) {
		const guidance = continueMatch[1]?.trim();
		return { action: "continue", guidance: guidance || undefined };
	}

	const fixMatch = trimmed.match(/^fix\s*[:-]?\s*(.+)$/i);
	if (fixMatch) {
		const guidance = fixMatch[1]?.trim();
		return { action: "continue", guidance: guidance || undefined };
	}

	return null;
}

function parseResumeDecision(
	text: string,
): "resume" | "start-fresh" | "abort" | null {
	const value = normalize(text).replace("start fresh", "start-fresh");
	if (value === "r" || value === "resume") return "resume";
	if (value === "n" || value === "new" || value === "start-fresh") {
		return "start-fresh";
	}
	if (value === "q" || value === "abort") return "abort";
	return null;
}

async function createGateSession(
	client: OpencodeClient,
	tui: TuiController,
	title: string,
): Promise<string> {
	const created = await client.session.create({ title });
	if (created.error || !created.data?.id) {
		throw new Error(
			`Failed to create gate session: ${created.error ? JSON.stringify(created.error) : "no data"}`,
		);
	}

	try {
		await tui.selectSession(created.data.id);
	} catch {
		// Best effort only.
	}

	return created.data.id;
}

async function deleteGateSession(
	client: OpencodeClient,
	sessionId: string,
): Promise<void> {
	try {
		await client.session.delete({ sessionID: sessionId });
	} catch {
		// Best effort only.
	}
}

function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || /abort/i.test(err.message);
}

async function waitForParsedUserDecision<T>(
	client: OpencodeClient,
	sessionId: string,
	signal: AbortSignal,
	parse: (text: string) => T | null,
	onInvalid: (text: string) => Promise<void>,
): Promise<T> {
	const api = client as unknown as {
		event: {
			subscribe: (
				options?: unknown,
				req?: { signal?: AbortSignal },
			) => Promise<{ stream: AsyncIterable<unknown> }>;
		};
	};

	const { stream } = await api.event.subscribe(undefined, { signal });
	const textByMessage = new Map<string, string>();
	const roleByMessage = new Map<string, string>();

	for await (const raw of stream) {
		if (signal.aborted) throw new Error("aborted");

		const event = raw as {
			type?: string;
			properties?: Record<string, unknown>;
		};

		if (event.type === "message.updated") {
			const info = event.properties?.info as
				| { id?: string; sessionID?: string; role?: string }
				| undefined;
			if (!info || info.sessionID !== sessionId || !info.id || !info.role) {
				continue;
			}

			roleByMessage.set(info.id, info.role);
			if (info.role !== "user") continue;

			const text = textByMessage.get(info.id);
			if (!text) continue;

			const parsed = parse(text);
			if (parsed !== null) return parsed;
			await onInvalid(text);
			continue;
		}

		if (event.type !== "message.part.updated") continue;

		const part = event.properties?.part as
			| { type?: string; sessionID?: string; messageID?: string; text?: string }
			| undefined;

		if (
			!part ||
			part.type !== "text" ||
			part.sessionID !== sessionId ||
			!part.messageID
		) {
			continue;
		}

		const delta =
			typeof event.properties?.delta === "string"
				? event.properties.delta
				: undefined;
		const previous = textByMessage.get(part.messageID) ?? "";
		const next =
			typeof part.text === "string"
				? part.text
				: delta
					? `${previous}${delta}`
					: previous;

		textByMessage.set(part.messageID, next);

		if (roleByMessage.get(part.messageID) !== "user") continue;

		const parsed = parse(next);
		if (parsed !== null) return parsed;
		await onInvalid(next);
	}

	throw new Error("Gate event stream ended unexpectedly");
}

async function runWithGateLifecycle<T>(
	tui: TuiController,
	opts: TuiGateOptions,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T | "abort"> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
	const gateAbort = new AbortController();

	const onOuterAbort = () => gateAbort.abort();
	if (opts.signal) {
		if (opts.signal.aborted) gateAbort.abort();
		else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
	}

	const timeout = setTimeout(() => gateAbort.abort(), timeoutMs);
	timeout.unref?.();
	const unsubscribeExit = tui.onExit(() => gateAbort.abort());

	try {
		return await run(gateAbort.signal);
	} catch (err) {
		if (gateAbort.signal.aborted || isAbortError(err)) return "abort";
		throw err;
	} finally {
		clearTimeout(timeout);
		unsubscribeExit();
		if (opts.signal) {
			opts.signal.removeEventListener("abort", onOuterAbort);
		}
	}
}

export function createTuiPhaseGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (summary: PhaseSummary) => Promise<"continue" | "review" | "abort"> {
	return async (summary): Promise<"continue" | "review" | "abort"> => {
		if (!tui.active) return headlessPhaseGate(summary);

		const sessionId = await createGateSession(
			client,
			tui,
			`Gate: Phase ${summary.phaseNumber} — ${summary.phaseTitle}`,
		);

		try {
			await tui.showToast(
				`Phase ${summary.phaseNumber} complete. Reply with continue, review, or abort.`,
				"info",
			);
		} catch {
			// Best effort only.
		}

		try {
			const decision = await runWithGateLifecycle(tui, opts, (signal) =>
				waitForParsedUserDecision(
					client,
					sessionId,
					signal,
					parsePhaseDecision,
					async (text) => {
						try {
							await tui.showToast(
								`Invalid input: "${text.trim()}". Use continue, review, or abort.`,
								"warning",
							);
						} catch {
							// Best effort only.
						}
					},
				),
			);

			return decision === "abort" ? "abort" : decision;
		} finally {
			await deleteGateSession(client, sessionId);
		}
	};
}

export function createTuiEscalationGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (event: EscalationEvent) => Promise<EscalationResponse> {
	return async (event): Promise<EscalationResponse> => {
		if (!tui.active) return headlessEscalationGate(event);

		const shortReason =
			event.reason.length > 60
				? `${event.reason.slice(0, 60)}...`
				: event.reason;
		const sessionId = await createGateSession(
			client,
			tui,
			`Escalation: ${shortReason}`,
		);

		try {
			await tui.showToast(
				"Escalation requires input. Reply with approve, abort, or continue[: guidance].",
				"error",
			);
		} catch {
			// Best effort only.
		}

		try {
			const decision = await runWithGateLifecycle(tui, opts, (signal) =>
				waitForParsedUserDecision(
					client,
					sessionId,
					signal,
					parseEscalationDecision,
					async (text) => {
						try {
							await tui.showToast(
								`Invalid input: "${text.trim()}". Use approve, abort, or continue[: guidance].`,
								"warning",
							);
						} catch {
							// Best effort only.
						}
					},
				),
			);

			if (decision === "abort") return { action: "abort" };
			return decision;
		} finally {
			await deleteGateSession(client, sessionId);
		}
	};
}

export function createTuiResumeGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (
	runId: string,
	phase: string,
	state: string,
) => Promise<"resume" | "start-fresh" | "abort"> {
	return async (
		runId,
		phase,
		state,
	): Promise<"resume" | "start-fresh" | "abort"> => {
		if (!tui.active) return headlessResumeGate(runId, phase, state);

		const sessionId = await createGateSession(
			client,
			tui,
			`Resume: Run ${runId.slice(0, 8)}`,
		);

		try {
			await tui.showToast(
				`Interrupted run at ${phase}/${state}. Reply with resume, start-fresh, or abort.`,
				"info",
			);
		} catch {
			// Best effort only.
		}

		try {
			const decision = await runWithGateLifecycle(tui, opts, (signal) =>
				waitForParsedUserDecision(
					client,
					sessionId,
					signal,
					parseResumeDecision,
					async (text) => {
						try {
							await tui.showToast(
								`Invalid input: "${text.trim()}". Use resume, start-fresh, or abort.`,
								"warning",
							);
						} catch {
							// Best effort only.
						}
					},
				),
			);

			return decision === "abort" ? "abort" : decision;
		} finally {
			await deleteGateSession(client, sessionId);
		}
	};
}

export function createTuiHumanGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (event: EscalationEvent) => Promise<"continue" | "approve" | "abort"> {
	const escalationGate = createTuiEscalationGate(client, tui, opts);
	return async (event) => {
		const decision = await escalationGate(event);
		return decision.action;
	};
}

export function createTuiPlanReviewResumeGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (
	runId: string,
	iteration: number,
) => Promise<"resume" | "start-fresh" | "abort"> {
	const resumeGate = createTuiResumeGate(client, tui, opts);
	return (runId, iteration) =>
		resumeGate(runId, `iteration-${iteration}`, "REVIEW");
}
