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
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString();
			if (text.includes("\n")) {
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
				resolve(text.split("\n")[0] ?? "");
			}
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

function isInteractive(): boolean {
	return !!process.stdin.isTTY;
}

// ---------------------------------------------------------------------------
// Phase gate
// ---------------------------------------------------------------------------

/**
 * Display a phase completion summary and prompt the human to continue,
 * review, or abort.
 */
export async function phaseGate(
	summary: PhaseSummary,
): Promise<"continue" | "review" | "abort"> {
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
	console.log("    r = review (inspect changes before continuing)");
	console.log("    q = abort");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — aborting.");
		return "abort";
	}

	process.stdout.write("  Choice [c/r/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "c" || choice === "continue") return "continue";
	if (choice === "r" || choice === "review") return "review";
	return "abort";
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

	console.log();
	console.log("  Options:");
	console.log("    c = continue (agent retries with your guidance)");
	console.log("    a = approve (accept current state, move on)");
	console.log("    q = abort (stop execution)");
	console.log();

	if (!isInteractive()) {
		console.log("  Non-interactive mode detected — aborting.");
		return { action: "abort" };
	}

	process.stdout.write("  Choice [c/a/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();

	if (choice === "a" || choice === "approve") {
		return { action: "approve" };
	}

	if (choice === "c" || choice === "continue") {
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
	phase: number,
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
