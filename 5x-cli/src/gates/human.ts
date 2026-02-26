/**
 * Interactive terminal prompts for human gates.
 *
 * Phase gate: pauses between phases for human approval.
 * Escalation gate: pauses when agents request human intervention.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseSummary {
	phaseNumber: string;
	phaseTitle: string;
	commit?: string;
	qualityPassed: boolean;
	reviewVerdict?: string;
	filesChanged?: number;
	duration?: number; // ms
}

export interface EscalationEvent {
	reason: string;
	items?: Array<{ id: string; title: string; reason: string }>;
	iteration: number;
	/** Path to the NDJSON agent log file, when the escalation originated from an agent invocation. */
	logPath?: string;
	/**
	 * The state machine state to resume when the user chooses "continue".
	 * Defaults to "EXECUTE" (re-run author) if not set, but reviewer timeouts
	 * and other non-author escalations should set this to "REVIEW", "AUTO_FIX", etc.
	 */
	retryState?: string;
}

export type EscalationResponse =
	| { action: "continue"; guidance?: string }
	| { action: "approve" }
	| { action: "abort" };

// ---------------------------------------------------------------------------
// Stdin helpers
// ---------------------------------------------------------------------------

/** Read a single line from stdin. */
function readLine(): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			process.removeListener("SIGINT", onSigint);
			process.stdin.pause();
		};

		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString();
			if (text.includes("\n")) {
				cleanup();
				resolve(text.split("\n")[0] ?? "");
			}
		};
		const onSigint = () => {
			cleanup();
			resolve("__SIGINT__");
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.once("SIGINT", onSigint);
	});
}

function isInteractive(): boolean {
	// Bun test sets NODE_ENV=test even when stdin is a TTY. Disable interactive
	// prompts in test runs to avoid hanging suites on readline gates.
	if (process.env.NODE_ENV === "test") return false;
	return !!process.stdin.isTTY;
}

// ---------------------------------------------------------------------------
// Phase gate
// ---------------------------------------------------------------------------

/**
 * Display a phase completion summary and prompt the human to continue,
 * or exit at this checkpoint.
 */
export async function phaseGate(
	summary: PhaseSummary,
): Promise<"continue" | "exit"> {
	console.log();
	console.log("  ──────────────────────────────────────");
	console.log(
		`  Phase ${summary.phaseNumber}: ${summary.phaseTitle} — Complete`,
	);
	console.log("  ──────────────────────────────────────");

	if (summary.commit) {
		console.log(`  Commit: ${summary.commit.slice(0, 8)}`);
	}
	console.log(
		`  Quality gates: ${summary.qualityPassed ? "PASSED" : "FAILED"}`,
	);
	if (summary.reviewVerdict) {
		console.log(`  Review verdict: ${summary.reviewVerdict}`);
	}
	if (summary.filesChanged !== undefined) {
		console.log(`  Files changed: ${summary.filesChanged}`);
	}
	if (summary.duration !== undefined) {
		const secs = Math.round(summary.duration / 1000);
		const mins = Math.floor(secs / 60);
		const display = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
		console.log(`  Duration: ${display}`);
	}

	console.log();
	console.log("  Options:");
	console.log("    c = continue to next phase");
	console.log("    x = exit now (resume from this checkpoint later)");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — exiting at checkpoint.");
		return "exit";
	}

	process.stdout.write("  Choice [c/x]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "c" || choice === "continue") return "continue";
	if (
		choice === "x" ||
		choice === "exit" ||
		choice === "review" ||
		choice === "r" ||
		choice === "abort" ||
		choice === "q" ||
		choice === "__sigint__"
	) {
		return "exit";
	}
	return "exit";
}

// ---------------------------------------------------------------------------
// Escalation gate
// ---------------------------------------------------------------------------

/**
 * Display an escalation event and prompt the human for guidance.
 */
export async function escalationGate(
	event: EscalationEvent,
): Promise<EscalationResponse> {
	console.log();
	console.log("  === Escalation: Human Review Required ===");
	console.log(`  Reason: ${event.reason}`);

	if (event.items && event.items.length > 0) {
		console.log("  Items requiring attention:");
		for (const item of event.items) {
			console.log(`    - [${item.id}] ${item.title}: ${item.reason}`);
		}
	}

	if (event.retryState) {
		console.log(`  Next step on fix: ${event.retryState}`);
	}

	console.log();
	console.log("  Options:");
	console.log(
		"    f = fix with guidance (agent addresses issues, then re-review)",
	);
	console.log("    o = override and move on (force approve this phase)");
	console.log("    q = abort (stop execution)");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — aborting.");
		return { action: "abort" };
	}

	process.stdout.write("  Choice [f/o/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();

	if (choice === "o" || choice === "override" || choice === "approve") {
		return { action: "approve" };
	}

	if (choice === "f" || choice === "fix" || choice === "continue") {
		process.stdout.write("  Guidance (optional, press Enter to skip): ");
		const guidance = await readLine();
		return {
			action: "continue",
			guidance: guidance.trim() || undefined,
		};
	}

	return { action: "abort" };
}

// ---------------------------------------------------------------------------
// Resume gate (for phase execution)
// ---------------------------------------------------------------------------

/**
 * Prompt the user to resume an interrupted run, start fresh, or abort.
 */
export async function resumeGate(
	runId: string,
	phase: string,
	state: string,
): Promise<"resume" | "start-fresh" | "abort"> {
	console.log();
	console.log(
		`  Found interrupted run ${runId.slice(0, 8)} at phase ${phase}, state ${state}.`,
	);
	console.log("  Options:");
	console.log("    r = resume from where it left off");
	console.log("    n = start fresh (marks old run as aborted)");
	console.log("    q = abort");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — aborting.");
		return "abort";
	}

	process.stdout.write("  Choice [r/n/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "r" || choice === "resume") return "resume";
	if (choice === "n" || choice === "new" || choice === "start-fresh")
		return "start-fresh";
	return "abort";
}

// ---------------------------------------------------------------------------
// Stale lock gate
// ---------------------------------------------------------------------------

/**
 * Prompt the user to steal a stale lock or abort.
 */
export async function staleLockGate(
	pid: number,
	startedAt: string,
): Promise<"steal" | "abort"> {
	console.log();
	console.log(
		`  Stale lock detected: PID ${pid} (started ${startedAt}) is no longer running.`,
	);
	console.log("  Options:");
	console.log("    s = steal the lock and proceed");
	console.log("    q = abort");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — aborting.");
		return "abort";
	}

	process.stdout.write("  Choice [s/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "s" || choice === "steal") return "steal";
	return "abort";
}
