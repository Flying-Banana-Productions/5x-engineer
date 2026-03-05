/**
 * Diff command handler — business logic for git diff inspection.
 *
 * Framework-independent: no citty imports.
 */

import { outputError, outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface DiffParams {
	since?: string;
	stat?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gitRun(
	args: string[],
	workdir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: workdir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Parse `git diff --stat` summary line: " N files changed, M insertions(+), D deletions(-)" */
function parseStatSummary(statOutput: string): {
	files_changed: number;
	insertions: number;
	deletions: number;
} {
	const lines = statOutput.split("\n");
	const summaryLine = lines[lines.length - 1] ?? "";

	const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
	const insertionsMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
	const deletionsMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

	return {
		files_changed: filesMatch
			? Number.parseInt(filesMatch[1] as string, 10)
			: 0,
		insertions: insertionsMatch
			? Number.parseInt(insertionsMatch[1] as string, 10)
			: 0,
		deletions: deletionsMatch
			? Number.parseInt(deletionsMatch[1] as string, 10)
			: 0,
	};
}

/** Get the list of changed file paths from a diff. */
function parseFileNames(nameOnlyOutput: string): string[] {
	return nameOnlyOutput
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runDiff(params: DiffParams): Promise<void> {
	const projectRoot = resolveProjectRoot();

	// Validate --since ref exists if provided
	const ref = params.since;
	if (ref) {
		const verifyResult = await gitRun(
			["rev-parse", "--verify", ref],
			projectRoot,
		);
		if (verifyResult.exitCode !== 0) {
			outputError("INVALID_REF", `Git ref not found: ${ref}`, { ref });
		}
	}

	// Build diff command
	// Without --since: show unstaged + staged changes against HEAD
	// With --since: show all changes since that ref
	const diffArgs = ref ? ["diff", ref] : ["diff", "HEAD"];
	const nameArgs = ref
		? ["diff", "--name-only", ref]
		: ["diff", "--name-only", "HEAD"];

	// Run diff and name-only in parallel
	const [diffResult, nameResult] = await Promise.all([
		gitRun(diffArgs, projectRoot),
		gitRun(nameArgs, projectRoot),
	]);

	if (diffResult.exitCode !== 0) {
		outputError("GIT_ERROR", `git diff failed: ${diffResult.stderr}`);
	}

	if (nameResult.exitCode !== 0) {
		outputError(
			"GIT_ERROR",
			`git diff --name-only failed: ${nameResult.stderr}`,
			{ command: "git diff --name-only" },
		);
	}

	const files = parseFileNames(nameResult.stdout);

	// Optionally get stat
	let stat:
		| { files_changed: number; insertions: number; deletions: number }
		| undefined;
	if (params.stat) {
		const statArgs = ref ? ["diff", "--stat", ref] : ["diff", "--stat", "HEAD"];
		const statResult = await gitRun(statArgs, projectRoot);
		if (statResult.exitCode !== 0) {
			outputError("GIT_ERROR", `git diff --stat failed: ${statResult.stderr}`, {
				command: "git diff --stat",
			});
		}
		stat = statResult.stdout
			? parseStatSummary(statResult.stdout)
			: { files_changed: 0, insertions: 0, deletions: 0 };
	}

	const data: Record<string, unknown> = {
		ref: ref ?? "HEAD",
		diff: diffResult.stdout,
		files,
	};

	if (stat !== undefined) {
		data.stat = stat;
	}

	outputSuccess(data);
}
