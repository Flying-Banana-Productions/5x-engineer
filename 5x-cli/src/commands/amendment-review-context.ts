/**
 * Trusted amendment review context for plan reviews inside an implementation
 * run. Render and invoke share this so both prompts carry the same
 * predecessor revision, exact committed plan hash, and plan diff.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CodeDiffError,
	readHeadCommit,
	workdirCodeDiffGit,
} from "../review-governance/code-diff.js";
import {
	formatAmendmentReviewPromptContext,
	readPendingAmendmentReview,
} from "../review-governance/implementation-amendment.js";
import {
	hashPlanBytes,
	planRepoPath,
	showPlanAtCommit,
} from "../review-governance/implementation-state.js";
import type { ReviewBudgetCommandContext } from "./review-budget-context.js";

export type AmendmentReviewContextResult =
	| { status: "none" }
	| {
			status: "ready";
			append: string;
			authorizationId: string;
			predecessorRevisionId: string;
			reviewedPlanHash: string;
			headCommit: string;
	  }
	| { status: "error"; code: string; message: string };

/** Unified diff of two plan versions, labelled with the plan's repo path. */
export async function diffPlanBytes(input: {
	before: string;
	after: string;
	repoPath: string;
}): Promise<string> {
	if (input.before === input.after) return "";
	const root = mkdtempSync(join(tmpdir(), "5x-amendment-diff-"));
	try {
		for (const [side, bytes] of [
			["a", input.before],
			["b", input.after],
		] as const) {
			const path = join(root, side, input.repoPath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, bytes, "utf8");
		}
		const result = await workdirCodeDiffGit(root).exec(
			[
				"diff",
				"--no-index",
				"--no-color",
				"--no-ext-diff",
				"--no-prefix",
				"--",
				`a/${input.repoPath}`,
				`b/${input.repoPath}`,
			],
			{ exact: true },
		);
		// `git diff --no-index` exits 1 when the files differ.
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			throw new CodeDiffError(
				"CODE_DIFF_GIT_ERROR",
				result.stderr || "git diff --no-index failed for the plan diff.",
			);
		}
		return result.stdout;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Build the trusted amendment block for a reviewer-plan prompt. Returns
 * `none` when the run has no pending scoped amendment authorization.
 * The reviewed hash is over the plan bytes committed at HEAD, the same
 * bytes `5x review implementation amend` registers.
 */
export async function resolveAmendmentReviewContext(input: {
	ctx: ReviewBudgetCommandContext;
	runId: string;
	warn: (message: string) => void;
}): Promise<AmendmentReviewContextResult> {
	const { ctx, runId } = input;
	const pending = readPendingAmendmentReview({
		recordStore: ctx.recordStore,
		runId,
	});
	if (!pending.ok) {
		return {
			status: "error",
			code: "AMENDMENT_REVIEW_CONTEXT_UNAVAILABLE",
			message: pending.message,
		};
	}
	if (!pending.pending) return { status: "none" };
	const workdir = ctx.executionContext.effectiveWorkingDirectory;
	const repoRoot = ctx.executionContext.controlPlaneRoot;
	const planPath = ctx.executionContext.run.plan_path;
	const repoPath = planRepoPath(planPath, repoRoot);
	if (!repoPath) {
		return {
			status: "error",
			code: "AMENDMENT_REVIEW_CONTEXT_UNAVAILABLE",
			message: `Plan path ${planPath} is outside the repository.`,
		};
	}
	let headCommit: string;
	let committed: string | null;
	let planDiff: string;
	try {
		headCommit = await readHeadCommit(workdirCodeDiffGit(workdir));
		committed = await showPlanAtCommit(workdir, headCommit, planPath, {
			repoRoot,
		});
		if (committed === null) {
			return {
				status: "error",
				code: "AMENDMENT_REVIEW_CONTEXT_UNAVAILABLE",
				message: `The amended plan ${repoPath} is not committed at HEAD ${headCommit}. Commit the amendment before plan review.`,
			};
		}
		planDiff = await diffPlanBytes({
			before: pending.pending.predecessorPlanBytes,
			after: committed,
			repoPath,
		});
	} catch (error) {
		return {
			status: "error",
			code: error instanceof CodeDiffError ? error.code : "CODE_DIFF_GIT_ERROR",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	let worktreeBytes: string | null;
	try {
		worktreeBytes = readFileSync(
			ctx.executionContext.effectivePlanPath,
			"utf8",
		);
	} catch {
		worktreeBytes = null;
	}
	if (worktreeBytes !== committed) {
		input.warn(
			`The worktree plan differs from HEAD ${headCommit}. The amendment review covers the committed bytes; commit the plan first, because registration rejects uncommitted plan changes.`,
		);
	}
	const reviewedPlanHash = hashPlanBytes(committed);
	return {
		status: "ready",
		append: formatAmendmentReviewPromptContext({
			predecessorRevisionId: pending.pending.predecessorRevisionId,
			reviewedPlanHash,
			planDiff,
		}),
		authorizationId: pending.pending.authorizationId,
		predecessorRevisionId: pending.pending.predecessorRevisionId,
		reviewedPlanHash,
		headCommit,
	};
}
