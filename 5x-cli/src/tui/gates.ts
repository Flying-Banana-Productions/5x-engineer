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
	directory?: string;
}

function normalize(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parsePhaseDecision(text: string): "continue" | "exit" | null {
	const value = normalize(text);
	if (value === "c" || value === "continue") return "continue";
	if (
		value === "x" ||
		value === "exit" ||
		value === "r" ||
		value === "review" ||
		value === "q" ||
		value === "abort"
	) {
		return "exit";
	}
	return null;
}

export function parseEscalationDecision(
	text: string,
	opts?: { canContinueSession?: boolean },
):
	| { action: "continue"; guidance?: string }
	| { action: "continue_session"; guidance?: string }
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

	// "c" / "continue-session" → continue_session (only when eligible)
	if (opts?.canContinueSession) {
		if (value === "c" || value === "continue-session") {
			return { action: "continue_session" };
		}
		const csMatch = trimmed.match(/^(?:continue-session|c)\s*[:-]?\s*(.+)$/i);
		if (csMatch) {
			const guidance = csMatch[1]?.trim();
			return { action: "continue_session", guidance: guidance || undefined };
		}
	} else {
		// When continuation is ineligible, reject continue-session variants
		// (with or without guidance) so they don't fall through to the
		// "continue" regex and silently start a fresh session.
		if (value === "c" || value === "continue-session") return null;
		if (/^continue-session\s*[:-]?\s*.+$/i.test(trimmed)) return null;
		if (/^c\s*[:-]\s*.+$/i.test(trimmed)) return null;
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
	directory?: string,
): Promise<string> {
	const created = await client.session.create({
		title,
		...(directory ? { directory } : {}),
	});
	if (created.error || !created.data?.id) {
		throw new Error(
			`Failed to create gate session: ${created.error ? JSON.stringify(created.error) : "no data"}`,
		);
	}

	try {
		await tui.selectSession(created.data.id, directory);
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
): Promise<
	{ type: "ok"; value: T } | { type: "abort" } | { type: "tui-exit" }
> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
	const gateAbort = new AbortController();
	let abortedByTuiExit = false;

	const onOuterAbort = () => gateAbort.abort();
	if (opts.signal) {
		if (opts.signal.aborted) gateAbort.abort();
		else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
	}

	const timeout = setTimeout(() => gateAbort.abort(), timeoutMs);
	timeout.unref?.();
	const unsubscribeExit = tui.onExit(() => {
		abortedByTuiExit = true;
		gateAbort.abort();
	});

	try {
		return { type: "ok", value: await run(gateAbort.signal) };
	} catch (err) {
		if (gateAbort.signal.aborted || isAbortError(err)) {
			if (abortedByTuiExit && !opts.signal?.aborted) {
				return { type: "tui-exit" };
			}
			return { type: "abort" };
		}
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
): (summary: PhaseSummary) => Promise<"continue" | "exit" | "abort"> {
	return async (summary): Promise<"continue" | "exit" | "abort"> => {
		if (!tui.active) return headlessPhaseGate(summary);

		const sessionId = await createGateSession(
			client,
			tui,
			`Gate: Phase ${summary.phaseNumber} — ${summary.phaseTitle}`,
			opts.directory,
		);

		try {
			await tui.showToast(
				`Phase ${summary.phaseNumber} complete. Reply with continue or exit.`,
				"info",
			);
		} catch {
			// Best effort only.
		}

		try {
			const lifecycle = await runWithGateLifecycle(tui, opts, (signal) =>
				waitForParsedUserDecision(
					client,
					sessionId,
					signal,
					parsePhaseDecision,
					async (text) => {
						try {
							await tui.showToast(
								`Invalid input: "${text.trim()}". Use continue or exit.`,
								"warning",
							);
						} catch {
							// Best effort only.
						}
					},
				),
			);

			if (lifecycle.type === "tui-exit") {
				return headlessPhaseGate(summary);
			}
			if (lifecycle.type === "abort") {
				return "abort";
			}

			const decision = lifecycle.value;
			return decision;
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

		const canContinueSession = Boolean(event.sessionId);
		const shortReason =
			event.reason.length > 60
				? `${event.reason.slice(0, 60)}...`
				: event.reason;
		const gateSessionId = await createGateSession(
			client,
			tui,
			`Escalation: ${shortReason}`,
			opts.directory,
		);

		try {
			const toastMsg = canContinueSession
				? "Escalation requires input. Reply with continue-session, fix, approve, or abort."
				: "Escalation requires input. Reply with fix, approve, or abort.";
			await tui.showToast(toastMsg, "error");
		} catch {
			// Best effort only.
		}

		try {
			const validOptions = canContinueSession
				? "continue-session, fix, approve, or abort"
				: "fix, approve, or abort";
			const lifecycle = await runWithGateLifecycle(tui, opts, (signal) =>
				waitForParsedUserDecision(
					client,
					gateSessionId,
					signal,
					(text) => parseEscalationDecision(text, { canContinueSession }),
					async (text) => {
						try {
							await tui.showToast(
								`Invalid input: "${text.trim()}". Use ${validOptions}.`,
								"warning",
							);
						} catch {
							// Best effort only.
						}
					},
				),
			);

			if (lifecycle.type === "tui-exit") {
				return headlessEscalationGate(event);
			}
			if (lifecycle.type === "abort") {
				return { action: "abort" };
			}

			const decision = lifecycle.value;
			return decision;
		} finally {
			await deleteGateSession(client, gateSessionId);
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
			opts.directory,
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
			const lifecycle = await runWithGateLifecycle(tui, opts, (signal) =>
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

			if (lifecycle.type === "tui-exit") {
				return headlessResumeGate(runId, phase, state);
			}
			if (lifecycle.type === "abort") {
				return "abort";
			}

			const decision = lifecycle.value;

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
): (
	event: EscalationEvent,
) => Promise<"continue" | "continue_session" | "approve" | "abort"> {
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
