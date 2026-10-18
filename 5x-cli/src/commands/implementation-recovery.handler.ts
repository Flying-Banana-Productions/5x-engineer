import { readFileSync } from "node:fs";
import { CliError } from "../output.js";
import {
	assertCleanCodeWorktree,
	changedCodePaths,
	isCodeAncestor,
	readHeadCommit,
	resolveCodeCommit,
	workdirCodeDiffGit,
} from "../review-governance/code-diff.js";
import {
	implementationRecoveryReview,
	type RecoverImplementationPlanInput,
	recoverImplementationPlan,
} from "../review-governance/implementation-recovery.js";
import { showPlanAtCommit } from "../review-governance/implementation-state.js";
import type { ReviewBudgetCommandContext } from "./review-budget-context.js";

/** Recovery is deliberately operator-driven; ordinary render/invoke never attaches it. */
export async function recoverImplementationPlanCommand(
	input: RecoverImplementationPlanInput,
	ctx: ReviewBudgetCommandContext,
) {
	const binding = ctx.store.getImplementationBinding(input.runId);
	if (!binding)
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"No existing binding to recover.",
		);
	const receiptResult = (
		result: ReturnType<typeof recoverImplementationPlan>,
	) => {
		const { authorizedPlanBytes: _bytes, ...receipt } = result.recovery;
		return {
			...result,
			recovery: receipt,
			preservedBinding: {
				id: binding.id,
				sourceRunId: binding.sourceRunId,
				b0: binding.b0,
				governingB: binding.governingB,
				mode: binding.mode,
			},
		};
	};
	const accepted = ctx.store
		.listImplementationTextAmendments(input.runId, binding.id)
		.find(
			(entry) =>
				entry.kind === "implementation-plan-recovery" &&
				entry.authorizationId === input.authorizationId,
		);
	if (accepted?.kind === "implementation-plan-recovery") {
		if (
			accepted.phase !== input.phase ||
			accepted.authorizationId !== input.authorizationId ||
			accepted.snapshotId !== input.snapshotId ||
			accepted.afterCommit !== input.commit ||
			accepted.scopeConfirmation !== input.scopeConfirmation ||
			accepted.preservedPhaseConfirmation !== input.preservedPhaseConfirmation
		) {
			throw new CliError(
				"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
				"This amendment authorization already has a different accepted recovery. Inspect its receipt; further amendments require a new authorization and plan review.",
			);
		}
		// Receipt replay is not a new admission. Later code/checklist work does not
		// invalidate idempotent recovery retries; ordinary admission still checks drift.
		return receiptResult({
			created: false,
			dryRun: Boolean(input.dryRun),
			recovery: accepted,
			completionAuthorized: false,
			nextAction: "implementation_corrections",
		});
	}
	const workdir = ctx.executionContext.effectiveWorkingDirectory;
	const git = workdirCodeDiffGit(workdir);
	const commit = await resolveCodeCommit(git, input.commit);
	if (commit !== input.commit)
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"Supply the full recorded amendment commit hash.",
		);
	const source = ctx.store
		.listImplementationReviewContexts(input.runId, binding.id)
		.filter((entry) => entry.phase === input.phase)
		.at(-1);
	if (!source)
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"The frontier has no recorded implementation review context.",
		);
	const { steps, reviewerIndex, finalCorrections } =
		implementationRecoveryReview(input, ctx.recordStore, ctx.store);
	const reviewBoundary = steps
		.slice(0, reviewerIndex)
		.reverse()
		.find((step) => step.step_name === "git:commit");
	const boundaryCommit = (
		reviewBoundary?.result_json as { hash?: string } | undefined
	)?.hash;
	const head = await readHeadCommit(git);
	if (
		!boundaryCommit ||
		!(await isCodeAncestor(git, commit, head)) ||
		!(await isCodeAncestor(git, boundaryCommit, head)) ||
		!(await isCodeAncestor(git, source.reviewedCommit, commit)) ||
		!(await isCodeAncestor(
			git,
			finalCorrections ? boundaryCommit : commit,
			finalCorrections ? commit : boundaryCommit,
		))
	) {
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"The amendment and recorded pre-review commit must be reachable ancestors of HEAD.",
		);
	}
	// Only existing excluded plan/review/run paths may change during preparation.
	// The plan itself is checked exactly below; shared design docs are not excluded.
	await assertCleanCodeWorktree(git, source.excludedPaths);
	if (
		(
			await changedCodePaths(
				git,
				source.reviewedCommit,
				head,
				source.excludedPaths,
			)
		).length
	) {
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"Non-workflow files changed during amendment preparation. Obtain a fresh scoped review before recovery.",
		);
	}
	const planPath = ctx.executionContext.run.plan_path;
	const committedPlanBytes = await showPlanAtCommit(workdir, commit, planPath, {
		repoRoot: ctx.executionContext.controlPlaneRoot,
	});
	const boundaryPlan = await showPlanAtCommit(
		workdir,
		boundaryCommit,
		planPath,
		{ repoRoot: ctx.executionContext.controlPlaneRoot },
	);
	if (
		committedPlanBytes === null ||
		(!finalCorrections && boundaryPlan !== committedPlanBytes)
	) {
		throw new CliError(
			"IMPLEMENTATION_RECOVERY_UNSUPPORTED",
			"The recorded pre-review plan does not match the amendment commit.",
		);
	}
	const result = recoverImplementationPlan(input, {
		recordStore: ctx.recordStore,
		store: ctx.store,
		origin: ctx.originFor({ kind: "human", role: "operator" }),
		committedPlanBytes,
		worktreePlanBytes: readFileSync(
			ctx.executionContext.effectivePlanPath,
			"utf8",
		),
	});
	return receiptResult(result);
}
