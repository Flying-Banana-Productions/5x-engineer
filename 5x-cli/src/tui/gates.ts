/**
 * TUI-native gate implementations for human interaction in non-auto mode.
 *
 * Phase 5 of 004-impl-5x-cli-tui.
 *
 * These gates use the TUI's control channel (`client.tui.*` APIs) to display
 * blocking dialogs for human decisions. They replace the readline-based gates
 * in `gates/human.ts` when running in TUI mode.
 *
 * ## Implementation notes:
 *
 * The OpenCode SDK does not provide a native `showDialog()` API for blocking
 * user input. Instead, we use a "gate session" pattern:
 * 1. Create a dedicated session for the gate (title reflects the decision needed)
 * 2. Show a toast notification to inform the user
 * 3. Use `client.session.prompt()` with a structured output format to get the decision
 * 4. The prompt asks the user to respond with a specific format
 * 5. Timeout after DEFAULT_GATE_TIMEOUT_MS (30 minutes) to prevent indefinite hangs
 * 6. Respect cancelController.signal for immediate abort on Ctrl-C
 *
 * This approach is deterministic: the gate resolves on a specific event
 * (the structured output response), not on generic SSE inference.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../gates/human.js";
import type { TuiController } from "./controller.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default gate timeout: 30 minutes (in milliseconds). */
export const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TuiGateOptions {
	/** Timeout in milliseconds before gate auto-aborts. Default: 30 minutes. */
	timeoutMs?: number;
	/** AbortSignal for immediate cancellation (e.g., Ctrl-C, TUI exit). */
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Create a promise that resolves with "abort" after a timeout.
 * Generic to allow proper typing in Promise.race with different gate return types.
 */
function createTimeoutPromise<T>(
	ms: number,
	_label: string,
): Promise<T | "abort"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve("abort");
		}, ms);
		// Clean up timer if promise is garbage collected (not strictly necessary but good practice)
		timer.unref?.();
	});
}

/**
 * Create a promise that resolves with "abort" when the signal is aborted.
 * Generic to allow proper typing in Promise.race with different gate return types.
 */
function createAbortPromise<T>(signal: AbortSignal): Promise<T | "abort"> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve("abort");
			return;
		}
		signal.addEventListener(
			"abort",
			() => {
				resolve("abort");
			},
			{ once: true },
		);
	});
}

/**
 * Check if TUI is still active; if not, return a promise that resolves to "abort".
 * Generic to allow proper typing based on the expected return type of the gate.
 */
function checkTuiActive<T>(
	tui: TuiController,
	_label: string,
): Promise<T | "abort"> | null {
	if (!tui.active) {
		return Promise.resolve("abort" as T | "abort");
	}
	return null;
}

// ---------------------------------------------------------------------------
// Phase Gate
// ---------------------------------------------------------------------------

/**
 * Create a TUI-native phase gate.
 *
 * Displays a blocking dialog in the TUI asking the user whether to continue,
 * review, or abort after a phase completes.
 */
export function createTuiPhaseGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (summary: PhaseSummary) => Promise<"continue" | "review" | "abort"> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

	return async (summary): Promise<"continue" | "review" | "abort"> => {
		// Check TUI is still active
		const tuiCheck = checkTuiActive<"continue" | "review" | "abort">(
			tui,
			"Phase gate",
		);
		if (tuiCheck) {
			const result = await tuiCheck;
			return result;
		}

		// Show toast notification (best-effort)
		try {
			await tui.showToast(
				`Phase ${summary.phaseNumber} complete — awaiting decision`,
				"info",
			);
		} catch {
			// Ignore TUI errors
		}

		// Create a gate session for the decision
		const gateSession = await client.session.create({
			title: `Gate: Phase ${summary.phaseNumber} — ${summary.phaseTitle}`,
		});

		if (gateSession.error || !gateSession.data) {
			throw new Error(
				`Failed to create gate session: ${gateSession.error ? JSON.stringify(gateSession.error) : "no data"}`,
			);
		}

		// Select the session in TUI (best-effort)
		try {
			await tui.selectSession(gateSession.data.id);
		} catch {
			// Ignore TUI errors
		}

		// Build the prompt asking for a decision
		const promptText = buildPhaseGatePrompt(summary);

		// Race between: user response, timeout, abort signal, TUI exit
		try {
			const result = await Promise.race<"continue" | "review" | "abort">([
				promptForDecision(client, gateSession.data.id, promptText, [
					"continue",
					"review",
					"abort",
				] as const),
				createTimeoutPromise<"continue" | "review" | "abort">(
					timeoutMs,
					"Phase gate",
				),
				opts.signal
					? createAbortPromise<"continue" | "review" | "abort">(opts.signal)
					: new Promise<"continue" | "review" | "abort">(() => {}),
				watchTuiExit(tui),
			]);

			return result;
		} finally {
			// Clean up the gate session
			try {
				await client.session.delete({ sessionID: gateSession.data.id });
			} catch {
				// Ignore cleanup errors
			}
		}
	};
}

function buildPhaseGatePrompt(summary: PhaseSummary): string {
	const lines = [
		`Phase ${summary.phaseNumber}: ${summary.phaseTitle} — Complete`,
		"",
	];

	if (summary.commit) {
		lines.push(`Commit: ${summary.commit.slice(0, 8)}`);
	}
	lines.push(`Quality gates: ${summary.qualityPassed ? "PASSED" : "FAILED"}`);
	if (summary.reviewVerdict) {
		lines.push(`Review verdict: ${summary.reviewVerdict}`);
	}
	if (summary.filesChanged !== undefined) {
		lines.push(`Files changed: ${summary.filesChanged}`);
	}
	if (summary.duration !== undefined) {
		const secs = Math.round(summary.duration / 1000);
		const mins = Math.floor(secs / 60);
		const display = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
		lines.push(`Duration: ${display}`);
	}

	lines.push(
		"",
		"Please choose an action:",
		'- Type "continue" to proceed to the next phase',
		'- Type "review" to pause and inspect changes before continuing',
		'- Type "abort" to stop execution',
		"",
		"What would you like to do? (continue/review/abort)",
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Escalation Gate
// ---------------------------------------------------------------------------

/**
 * Create a TUI-native escalation gate.
 *
 * Displays a blocking dialog when human intervention is required,
 * offering options to continue with guidance, approve/override, or abort.
 */
export function createTuiEscalationGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (event: EscalationEvent) => Promise<EscalationResponse> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

	return async (event: EscalationEvent): Promise<EscalationResponse> => {
		// Check TUI is still active
		const tuiCheck = checkTuiActive<EscalationResponse>(tui, "Escalation gate");
		if (tuiCheck) {
			const result = await tuiCheck;
			// Return abort action if TUI exited
			if (result === "abort") {
				return { action: "abort" };
			}
		}

		// Show toast notification (best-effort)
		try {
			await tui.showToast(`Escalation: ${event.reason}`, "error");
		} catch {
			// Ignore TUI errors
		}

		// Create a gate session for the decision
		const gateSession = await client.session.create({
			title: `Escalation: ${event.reason.slice(0, 50)}...`,
		});

		if (gateSession.error || !gateSession.data) {
			throw new Error(
				`Failed to create gate session: ${gateSession.error ? JSON.stringify(gateSession.error) : "no data"}`,
			);
		}

		// Select the session in TUI (best-effort)
		try {
			await tui.selectSession(gateSession.data.id);
		} catch {
			// Ignore TUI errors
		}

		// Build the prompt
		const promptText = buildEscalationPrompt(event);

		// Race between: user response, timeout, abort signal, TUI exit
		try {
			const decision = await Promise.race<EscalationResponse | "abort">([
				promptForEscalationDecision(client, gateSession.data.id, promptText),
				createTimeoutPromise<EscalationResponse>(timeoutMs, "Escalation gate"),
				opts.signal
					? createAbortPromise<EscalationResponse>(opts.signal)
					: new Promise(() => {}),
				watchTuiExit(tui),
			]);

			// If timeout, abort signal, or TUI exit fired, return abort action
			if (decision === "abort") {
				return { action: "abort" };
			}

			return decision;
		} finally {
			// Clean up the gate session
			try {
				await client.session.delete({ sessionID: gateSession.data.id });
			} catch {
				// Ignore cleanup errors
			}
		}
	};
}

function buildEscalationPrompt(event: EscalationEvent): string {
	const lines = [
		"=== Escalation: Human Review Required ===",
		`Reason: ${event.reason}`,
		"",
	];

	if (event.items && event.items.length > 0) {
		lines.push("Items requiring attention:");
		for (const item of event.items) {
			lines.push(`  - [${item.id}] ${item.title}: ${item.reason}`);
		}
		lines.push("");
	}

	if (event.retryState) {
		lines.push(`Next step on fix: ${event.retryState}`);
		lines.push("");
	}

	lines.push(
		"Please choose an action:",
		'- Type "continue" to provide guidance and retry',
		'- Type "approve" to override and move on (force approve)',
		'- Type "abort" to stop execution',
		"",
		'If you choose "continue", you will be prompted for optional guidance.',
		"",
		"What would you like to do? (continue/approve/abort)",
	);

	return lines.join("\n");
}

async function promptForEscalationDecision(
	client: OpencodeClient,
	sessionId: string,
	promptText: string,
): Promise<EscalationResponse> {
	// First, get the main decision
	const decisionSchema = {
		type: "object" as const,
		properties: {
			action: {
				type: "string" as const,
				enum: ["continue", "approve", "abort"],
				description: "The user's chosen action",
			},
		},
		required: ["action"],
	};

	const result = await client.session.prompt({
		sessionID: sessionId,
		parts: [{ type: "text", text: promptText }],
		format: {
			type: "json_schema",
			schema: decisionSchema,
		},
	});

	if (result.error || !result.data) {
		throw new Error(
			`Failed to get decision: ${result.error ? JSON.stringify(result.error) : "no data"}`,
		);
	}

	const info = result.data.info;
	const decision = info.structured as {
		action: "continue" | "approve" | "abort";
	};

	if (decision.action === "approve") {
		return { action: "approve" };
	}

	if (decision.action === "abort") {
		return { action: "abort" };
	}

	// For "continue", ask for optional guidance
	const guidancePrompt = [
		"You chose to continue with guidance.",
		"",
		"Please provide guidance for the agent (or type 'skip' to continue without guidance):",
	].join("\n");

	const guidanceSchema = {
		type: "object" as const,
		properties: {
			guidance: {
				type: "string" as const,
				description: "Optional guidance for the agent, or 'skip' for none",
			},
		},
		required: ["guidance"],
	};

	const guidanceResult = await client.session.prompt({
		sessionID: sessionId,
		parts: [{ type: "text", text: guidancePrompt }],
		format: {
			type: "json_schema",
			schema: guidanceSchema,
		},
	});

	if (guidanceResult.error || !guidanceResult.data) {
		// If guidance fails, continue without it
		return { action: "continue" };
	}

	const guidanceOutput = guidanceResult.data.info.structured as {
		guidance: string;
	};
	const guidance =
		guidanceOutput.guidance === "skip" ? undefined : guidanceOutput.guidance;

	return { action: "continue", guidance };
}

// ---------------------------------------------------------------------------
// Resume Gate
// ---------------------------------------------------------------------------

/**
 * Create a TUI-native resume gate.
 *
 * Displays a blocking dialog when resuming an interrupted run,
 * offering options to resume, start fresh, or abort.
 */
export function createTuiResumeGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (
	runId: string,
	phase: string,
	state: string,
) => Promise<"resume" | "start-fresh" | "abort"> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

	return async (
		runId,
		phase,
		state,
	): Promise<"resume" | "start-fresh" | "abort"> => {
		// Check TUI is still active
		const tuiCheck = checkTuiActive<"resume" | "start-fresh" | "abort">(
			tui,
			"Resume gate",
		);
		if (tuiCheck) {
			const result = await tuiCheck;
			return result;
		}

		// Show toast notification (best-effort)
		try {
			await tui.showToast(
				`Found interrupted run ${runId.slice(0, 8)} — awaiting decision`,
				"info",
			);
		} catch {
			// Ignore TUI errors
		}

		// Create a gate session for the decision
		const gateSession = await client.session.create({
			title: `Resume: Run ${runId.slice(0, 8)}`,
		});

		if (gateSession.error || !gateSession.data) {
			throw new Error(
				`Failed to create gate session: ${gateSession.error ? JSON.stringify(gateSession.error) : "no data"}`,
			);
		}

		// Select the session in TUI (best-effort)
		try {
			await tui.selectSession(gateSession.data.id);
		} catch {
			// Ignore TUI errors
		}

		// Build the prompt
		const promptText = buildResumePrompt(runId, phase, state);

		// Race between: user response, timeout, abort signal, TUI exit
		try {
			const result = await Promise.race<"resume" | "start-fresh" | "abort">([
				promptForDecision(client, gateSession.data.id, promptText, [
					"resume",
					"start-fresh",
					"abort",
				] as const),
				createTimeoutPromise<"resume" | "start-fresh" | "abort">(
					timeoutMs,
					"Resume gate",
				),
				opts.signal
					? createAbortPromise<"resume" | "start-fresh" | "abort">(opts.signal)
					: new Promise<"resume" | "start-fresh" | "abort">(() => {}),
				watchTuiExit(tui),
			]);

			return result;
		} finally {
			// Clean up the gate session
			try {
				await client.session.delete({ sessionID: gateSession.data.id });
			} catch {
				// Ignore cleanup errors
			}
		}
	};
}

function buildResumePrompt(
	runId: string,
	phase: string,
	state: string,
): string {
	return [
		`Found interrupted run ${runId.slice(0, 8)} at phase ${phase}, state ${state}.`,
		"",
		"Please choose an action:",
		'- Type "resume" to continue from where it left off',
		'- Type "start-fresh" to abandon the old run and start new',
		'- Type "abort" to stop execution',
		"",
		"What would you like to do? (resume/start-fresh/abort)",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Plan Review Human Gate (for plan-review-loop.ts)
// ---------------------------------------------------------------------------

/**
 * Create a TUI-native human gate for plan review escalation.
 *
 * Similar to escalation gate but with a simpler return type for plan-review.
 */
export function createTuiHumanGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (event: EscalationEvent) => Promise<"continue" | "approve" | "abort"> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

	return async (event): Promise<"continue" | "approve" | "abort"> => {
		// Check TUI is still active
		const tuiCheck = checkTuiActive<"continue" | "approve" | "abort">(
			tui,
			"Human gate",
		);
		if (tuiCheck) {
			const result = await tuiCheck;
			return result;
		}

		// Show toast notification (best-effort)
		try {
			await tui.showToast(`Human review required: ${event.reason}`, "error");
		} catch {
			// Ignore TUI errors
		}

		// Create a gate session for the decision
		const gateSession = await client.session.create({
			title: `Review: ${event.reason.slice(0, 50)}...`,
		});

		if (gateSession.error || !gateSession.data) {
			throw new Error(
				`Failed to create gate session: ${gateSession.error ? JSON.stringify(gateSession.error) : "no data"}`,
			);
		}

		// Select the session in TUI (best-effort)
		try {
			await tui.selectSession(gateSession.data.id);
		} catch {
			// Ignore TUI errors
		}

		// Build the prompt
		const promptText = buildHumanGatePrompt(event);

		// Race between: user response, timeout, abort signal, TUI exit
		try {
			const result = await Promise.race<"continue" | "approve" | "abort">([
				promptForDecision(client, gateSession.data.id, promptText, [
					"continue",
					"approve",
					"abort",
				] as const),
				createTimeoutPromise<"continue" | "approve" | "abort">(
					timeoutMs,
					"Human gate",
				),
				opts.signal
					? createAbortPromise<"continue" | "approve" | "abort">(opts.signal)
					: new Promise<"continue" | "approve" | "abort">(() => {}),
				watchTuiExit(tui),
			]);

			return result;
		} finally {
			// Clean up the gate session
			try {
				await client.session.delete({ sessionID: gateSession.data.id });
			} catch {
				// Ignore cleanup errors
			}
		}
	};
}

function buildHumanGatePrompt(event: EscalationEvent): string {
	const lines = [
		"=== Human Review Required ===",
		`Reason: ${event.reason}`,
		"",
	];

	if (event.items && event.items.length > 0) {
		lines.push("Items requiring human review:");
		for (const item of event.items) {
			lines.push(`  - [${item.id}] ${item.title}: ${item.reason}`);
		}
		lines.push("");
	}

	lines.push(
		"Please choose an action:",
		'- Type "continue" to fix and re-review',
		'- Type "approve" to override and move on (force approve)',
		'- Type "abort" to stop the review loop',
		"",
		"What would you like to do? (continue/approve/abort)",
	);

	return lines.join("\n");
}

/**
 * Create a TUI-native resume gate for plan review.
 *
 * Simplified version for plan-review-loop.ts that only takes runId and iteration.
 */
export function createTuiPlanReviewResumeGate(
	client: OpencodeClient,
	tui: TuiController,
	opts: TuiGateOptions = {},
): (
	runId: string,
	iteration: number,
) => Promise<"resume" | "start-fresh" | "abort"> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

	return async (
		runId,
		iteration,
	): Promise<"resume" | "start-fresh" | "abort"> => {
		// Check TUI is still active
		const tuiCheck = checkTuiActive<"resume" | "start-fresh" | "abort">(
			tui,
			"Resume gate",
		);
		if (tuiCheck) {
			const result = await tuiCheck;
			return result;
		}

		// Show toast notification (best-effort)
		try {
			await tui.showToast(
				`Found interrupted run ${runId.slice(0, 8)} — awaiting decision`,
				"info",
			);
		} catch {
			// Ignore TUI errors
		}

		// Create a gate session for the decision
		const gateSession = await client.session.create({
			title: `Resume: Run ${runId.slice(0, 8)}`,
		});

		if (gateSession.error || !gateSession.data) {
			throw new Error(
				`Failed to create gate session: ${gateSession.error ? JSON.stringify(gateSession.error) : "no data"}`,
			);
		}

		// Select the session in TUI (best-effort)
		try {
			await tui.selectSession(gateSession.data.id);
		} catch {
			// Ignore TUI errors
		}

		// Build the prompt
		const promptText = [
			`Found interrupted run ${runId.slice(0, 8)} at iteration ${iteration}.`,
			"",
			"Please choose an action:",
			'- Type "resume" to continue from where it left off',
			'- Type "start-fresh" to abandon the old run and start new',
			'- Type "abort" to stop execution',
			"",
			"What would you like to do? (resume/start-fresh/abort)",
		].join("\n");

		// Race between: user response, timeout, abort signal, TUI exit
		try {
			const result = await Promise.race<"resume" | "start-fresh" | "abort">([
				promptForDecision(client, gateSession.data.id, promptText, [
					"resume",
					"start-fresh",
					"abort",
				] as const),
				createTimeoutPromise<"resume" | "start-fresh" | "abort">(
					timeoutMs,
					"Resume gate",
				),
				opts.signal
					? createAbortPromise<"resume" | "start-fresh" | "abort">(opts.signal)
					: new Promise<"resume" | "start-fresh" | "abort">(() => {}),
				watchTuiExit(tui),
			]);

			return result;
		} finally {
			// Clean up the gate session
			try {
				await client.session.delete({ sessionID: gateSession.data.id });
			} catch {
				// Ignore cleanup errors
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a decision using structured output.
 * Generic to allow proper return type inference based on choices.
 */
async function promptForDecision<T extends string>(
	client: OpencodeClient,
	sessionId: string,
	promptText: string,
	choices: readonly T[],
): Promise<T> {
	const schema = {
		type: "object" as const,
		properties: {
			action: {
				type: "string" as const,
				enum: choices,
				description: "The user's chosen action",
			},
		},
		required: ["action"],
	};

	const result = await client.session.prompt({
		sessionID: sessionId,
		parts: [{ type: "text", text: promptText }],
		format: {
			type: "json_schema",
			schema,
		},
	});

	if (result.error || !result.data) {
		throw new Error(
			`Failed to get decision: ${result.error ? JSON.stringify(result.error) : "no data"}`,
		);
	}

	const decision = result.data.info.structured as { action: T };
	return decision.action;
}

/**
 * Watch for TUI exit and resolve with "abort" when it happens.
 * Uses { once: true } to avoid listener accumulation.
 */
function watchTuiExit(tui: TuiController): Promise<"abort"> {
	return new Promise((resolve) => {
		if (!tui.active) {
			resolve("abort");
			return;
		}
		tui.onExit(() => {
			resolve("abort");
		});
	});
}
