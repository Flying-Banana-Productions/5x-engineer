import type { Command } from "@commander-js/extra-typings";
import { outputError, outputSuccess } from "../output.js";
import { migratePlanSchema } from "../review-governance/schema-migration.js";
import { resolveDbContext } from "./context.js";
import { recoverImplementationPlanCommand } from "./implementation-recovery.handler.js";
import { createReviewBudgetContext } from "./review-budget-context.js";
import {
	bindApprovedImplementation,
	finishImplementationCorrections,
	type SubmitPlanReviewDecisionPayload,
	showReviewGate,
	submitReviewDecision,
} from "./review-decision.handler.js";
import { requireAmbientRunId } from "./run-identity.js";

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function scalar(
	values: string[] | undefined,
	name: string,
): string | undefined {
	if (!values?.length) return undefined;
	if (values.length !== 1)
		outputError("INVALID_ARGS", `${name} may be supplied only once`);
	return values[0];
}

async function contextFor(run: string | undefined) {
	const dbContext = await resolveDbContext();
	if (!dbContext.controlPlane)
		outputError(
			"NO_CONTROL_PLANE",
			"No 5x control-plane DB found. Initialize with 5x init first.",
		);
	const runId = requireAmbientRunId({
		explicitRun: run,
		db: dbContext.db,
		controlPlane: dbContext.controlPlane,
	});
	const context = await createReviewBudgetContext(
		{ runId, dbContext },
		(message) => console.error(`Warning: ${message}`),
	);
	return { runId, context };
}

const JSON_FIELDS = new Set([
	"choice",
	"rationale",
	"evidence",
	"findingRefs",
	"retained",
	"removed",
	"baseline",
	"approvedP",
	"approvedItemIds",
	"approvedWorkItemIds",
	"snapshotId",
	"claimAdjustments",
]);

export function registerReview(parent: Command) {
	const review = parent
		.command("review")
		.description("Plan-review governance gates and decisions");
	const gate = review
		.command("gate")
		.description("Inspect the current review gate");
	gate
		.command("show")
		.description(
			"Show causes, allowed choices, required fields, and eligible finding identities",
		)
		.option("--run <id>", "Run id (otherwise ambient run resolution is used)")
		.option("--phase <p>", "Implementation phase id")
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await showReviewGate(runId, { context }, { phase: opts.phase }),
			);
		});

	review
		.command("decide")
		.description(
			"Resolve a gate through the durable decision CAS (not generic prompt answer)",
		)
		.requiredOption("--gate <id>", "Gate id")
		.option("--run <id>", "Run id (otherwise ambient run resolution is used)")
		.option("--choice <choice>", "Decision choice", collect, [])
		.option("--rationale <text>", "Decision rationale", collect, [])
		.option("--evidence <text>", "Evidence (repeatable)", collect, [])
		.option("--finding <id>", "Eligible finding id (repeatable)", collect, [])
		.option("--retain <scope>", "Retained scope (repeatable)", collect, [])
		.option("--remove <scope>", "Removed scope (repeatable)", collect, [])
		.option(
			"--baseline <points>",
			"New positive integer budget/baseline",
			collect,
			[],
		)
		.option(
			"--approved-p <points>",
			"Approved architecture burden",
			collect,
			[],
		)
		.option("--approved-item <id>", "Approved reviewer item id", collect, [])
		.option(
			"--approved-work-item <id>",
			"Approved plan work-item id",
			collect,
			[],
		)
		.option(
			"--input-json <json|->",
			"Machine decision payload (including ID/fingerprint pairs) or - for stdin",
			collect,
			[],
		)
		.addHelpText(
			"after",
			'\nInspect requiredFieldsByChoice first with "5x review gate show". Flag input accepts finding IDs only; the CLI resolves fingerprints. --input-json is mutually exclusive with all decision flags.\n',
		)
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			const jsonArg = scalar(opts.inputJson, "--input-json");
			let payload: SubmitPlanReviewDecisionPayload;
			let findingIds: string[] = [];
			let claimAdjustments:
				| Parameters<typeof submitReviewDecision>[0]["claimAdjustments"]
				| undefined;
			if (jsonArg !== undefined) {
				const flagFields = [
					opts.choice,
					opts.rationale,
					opts.evidence,
					opts.finding,
					opts.retain,
					opts.remove,
					opts.baseline,
					opts.approvedP,
					opts.approvedItem,
					opts.approvedWorkItem,
				];
				if (flagFields.some((values) => values.length > 0))
					outputError(
						"INVALID_ARGS",
						"--input-json is mutually exclusive with decision flags",
					);
				let raw: unknown;
				try {
					raw = JSON.parse(jsonArg === "-" ? await Bun.stdin.text() : jsonArg);
				} catch {
					outputError("INVALID_ARGS", "--input-json must contain valid JSON");
				}
				if (!raw || typeof raw !== "object" || Array.isArray(raw))
					outputError("INVALID_ARGS", "--input-json must be an object");
				const unknown = Object.keys(raw as object).filter(
					(key) => !JSON_FIELDS.has(key),
				);
				if (unknown.length)
					outputError(
						"INVALID_ARGS",
						`--input-json contains CLI-owned or unknown fields: ${unknown.join(", ")}`,
					);
				payload = raw as SubmitPlanReviewDecisionPayload;
				claimAdjustments = (
					raw as {
						claimAdjustments?: NonNullable<
							Parameters<typeof submitReviewDecision>[0]["claimAdjustments"]
						>;
					}
				).claimAdjustments;
			} else {
				const choice = scalar(opts.choice, "--choice");
				const rationale = scalar(opts.rationale, "--rationale");
				if (!choice || !rationale)
					outputError(
						"INVALID_ARGS",
						"--choice and --rationale are required without --input-json",
					);
				const baselineRaw = scalar(opts.baseline, "--baseline");
				const approvedPRaw = scalar(opts.approvedP, "--approved-p");
				payload = {
					choice: choice as SubmitPlanReviewDecisionPayload["choice"],
					rationale,
					evidence: opts.evidence,
					retained: opts.retain,
					removed: opts.remove,
					...(baselineRaw !== undefined
						? { baseline: Number(baselineRaw) }
						: {}),
					...(approvedPRaw !== undefined
						? { approvedP: Number(approvedPRaw) }
						: {}),
					approvedItemIds: opts.approvedItem,
					approvedWorkItemIds: opts.approvedWorkItem,
				};
				findingIds = opts.finding;
			}
			outputSuccess(
				await submitReviewDecision(
					{
						runId,
						gateId: opts.gate,
						payload,
						findingIds,
						...(claimAdjustments ? { claimAdjustments } : {}),
					},
					{ context },
				),
			);
		});

	const implementation = review
		.command("implementation")
		.description("Bind execution to an approved plan review");
	implementation
		.command("bind")
		.description(
			"Bind an execution run to one approved plan-review source without capturing a new baseline",
		)
		.requiredOption("--run <id>", "Execution run id")
		.requiredOption("--source-run <id>", "Approved plan-review run id")
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await bindApprovedImplementation(
					{ executionRunId: runId, sourceRunId: opts.sourceRun },
					{ context },
				),
			);
		});

	implementation
		.command("recover-plan")
		.description(
			"Operator-confirmed amendment recovery at an unfinished frontier; repeatable with a new authorization and plan review; preserves binding/baseline and requires fresh implementation review",
		)
		.requiredOption("--run <id>", "Existing execution run")
		.requiredOption("--phase <p>", "Earliest affected, unfinished phase")
		.requiredOption(
			"--authorization <id>",
			"Accepted authorize_amendment decision",
		)
		.requiredOption(
			"--snapshot <id>",
			"Latest completed same-run plan review snapshot",
		)
		.requiredOption(
			"--commit <sha>",
			"Full recorded plan-amendment author commit",
		)
		.requiredOption(
			"--confirm-scope <text>",
			"Operator attestation: exact reviewed commit stays within authorization; include operating restrictions",
		)
		.requiredOption(
			"--confirm-preserved-phases <text>",
			"Operator attestation: shared/design changes do not invalidate earlier phase approvals",
		)
		.option("--dry-run", "Validate and preview without appending recovery")
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await recoverImplementationPlanCommand(
					{
						runId,
						phase: opts.phase,
						authorizationId: opts.authorization,
						snapshotId: opts.snapshot,
						commit: opts.commit,
						scopeConfirmation: opts.confirmScope,
						preservedPhaseConfirmation: opts.confirmPreservedPhases,
						dryRun: opts.dryRun,
					},
					context,
				),
			);
		});

	review
		.command("migrate-schema")
		.description(
			"Record a schema 0 to schema 1 migration. Equivalent mode is a mechanical proof. Selective mode confirms the operator exclusion digest. There is no snapshot flag.",
		)
		.requiredOption(
			"--run <id>",
			"Bound execution run or approved plan-review run",
		)
		.requiredOption("--commit <sha>", "Full sha of the schema 1 plan commit")
		.requiredOption("--mode <mode>", "equivalent or selective")
		.option(
			"--dry-run",
			"Print exclusions, non-governing text, and the digest without writing",
		)
		.option(
			"--confirm-exclusions <digest>",
			"Operator confirmation of the selective exclusion digest",
		)
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await migratePlanSchema(
					{
						runId,
						commit: opts.commit,
						mode: opts.mode,
						dryRun: opts.dryRun,
						confirmExclusions: opts.confirmExclusions,
					},
					context,
				),
			);
		});

	const corrections = review
		.command("corrections")
		.description(
			"Finish an eligible implementation correction with fresh quality",
		);
	corrections
		.command("finish")
		.description(
			"Run the full layered quality configuration for one recorded correction. No gate override or passed flag is accepted.",
		)
		.requiredOption("--run <id>", "Execution run id")
		.requiredOption("--phase <p>", "Implementation phase id")
		.requiredOption("--review <observation-id>", "Originating observation id")
		.requiredOption("--commit <sha>", "Recorded author correction commit")
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await finishImplementationCorrections(
					{
						runId,
						phase: opts.phase,
						observationId: opts.review,
						commit: opts.commit,
					},
					{ context },
				),
			);
		});
}
