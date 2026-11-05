import type { Command } from "@commander-js/extra-typings";
import { outputError, outputSuccess } from "../output.js";
import { migratePlanSchema } from "../review-governance/schema-migration.js";
import { resolveDbContext } from "./context.js";
import { createReviewBudgetContext } from "./review-budget-context.js";
import {
	amendImplementationPlanCommand,
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

function amendmentScopeFromFlags(opts: {
	predecessorRevision: string[];
	earliestAffectedPhase: string[];
	reopenCompletedPhases: string[];
	claimEdit: string[];
	resolutionRef: string[];
}) {
	const predecessorRevisionId = scalar(
		opts.predecessorRevision,
		"--predecessor-revision",
	);
	const earliestAffectedPhase = scalar(
		opts.earliestAffectedPhase,
		"--earliest-affected-phase",
	);
	const reopen = scalar(
		opts.reopenCompletedPhases,
		"--reopen-completed-phases",
	);
	if (!predecessorRevisionId || !earliestAffectedPhase || reopen === undefined)
		outputError(
			"INVALID_ARGS",
			"authorize_amendment requires --predecessor-revision, --earliest-affected-phase, and --reopen-completed-phases true|false",
		);
	if (reopen !== "true" && reopen !== "false")
		outputError(
			"INVALID_ARGS",
			"--reopen-completed-phases requires the token true or false",
		);
	const effects = new Set(["withdraw", "reduce_magnitude", "edit_contract"]);
	return {
		predecessorRevisionId,
		earliestAffectedPhase,
		reopenCompletedPhases: reopen === "true",
		claimEdits: opts.claimEdit.map((token) => {
			const separator = token.lastIndexOf(":");
			const creditClaimId = token.slice(0, separator);
			const effect = token.slice(separator + 1);
			if (separator <= 0 || !effects.has(effect))
				outputError(
					"INVALID_ARGS",
					"--claim-edit must be <creditClaimId>:<withdraw|reduce_magnitude|edit_contract>",
				);
			return { creditClaimId, effect };
		}),
		resolutionRefs: opts.resolutionRef.map((token) => {
			const parts = token.split("/");
			if (parts.length !== 3 || parts.some((part) => part.length === 0))
				outputError(
					"INVALID_ARGS",
					"--resolution-ref must be <phase>/<observation-id>/<finding-id>",
				);
			const [phase, observationId, findingId] = parts;
			return { phase, observationId, findingId };
		}),
	};
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
	"restriction",
	"amendmentScope",
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
		.option(
			"--restriction <text>",
			"Operating restriction for accept_with_restriction (for example a release condition)",
			collect,
			[],
		)
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
		.option(
			"--predecessor-revision <revision-id>",
			"Current revision an authorize_amendment decision may advance",
			collect,
			[],
		)
		.option(
			"--earliest-affected-phase <phase-id>",
			"Earliest phase the authorization permits an amendment to affect",
			collect,
			[],
		)
		.option(
			"--reopen-completed-phases <true|false>",
			"Required token. True consents to reopening completed phases at or after the authorized floor",
			collect,
			[],
		)
		.option(
			"--claim-edit <creditClaimId:effect>",
			"Permitted claim effect: withdraw, reduce_magnitude, or edit_contract. Repeatable; zero repetitions record []",
			collect,
			[],
		)
		.option(
			"--resolution-ref <phase/observation-id/finding-id>",
			"Finding the authorization may resolve. Repeatable; zero repetitions record []",
			collect,
			[],
		)
		.addHelpText(
			"after",
			'\nInspect requiredFieldsByChoice first with "5x review gate show". Flag input accepts finding IDs only; the CLI resolves fingerprints. --input-json is mutually exclusive with all decision flags.\nA new authorize_amendment decision requires amendmentScope from these flags or from --input-json. Rationale and gate prose are not scope. --reopen-completed-phases requires the true or false token; a bare flag is rejected. Historical decisions that omit amendmentScope stay valid and cannot authorize amend.\n',
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
					opts.restriction,
					opts.retain,
					opts.remove,
					opts.baseline,
					opts.approvedP,
					opts.approvedItem,
					opts.approvedWorkItem,
					opts.predecessorRevision,
					opts.earliestAffectedPhase,
					opts.reopenCompletedPhases,
					opts.claimEdit,
					opts.resolutionRef,
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
				const scopeFlags = [
					opts.predecessorRevision.length,
					opts.earliestAffectedPhase.length,
					opts.reopenCompletedPhases.length,
					opts.claimEdit.length,
					opts.resolutionRef.length,
				];
				if (
					choice !== "authorize_amendment" &&
					scopeFlags.some((count) => count > 0)
				)
					outputError(
						"INVALID_ARGS",
						"amendmentScope flags are only valid with --choice authorize_amendment",
					);
				const baselineRaw = scalar(opts.baseline, "--baseline");
				const approvedPRaw = scalar(opts.approvedP, "--approved-p");
				const restriction = scalar(opts.restriction, "--restriction");
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
					...(restriction !== undefined ? { restriction } : {}),
					...(choice === "authorize_amendment"
						? { amendmentScope: amendmentScopeFromFlags(opts) }
						: {}),
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
		.command("amend")
		.description(
			"Register a reviewed semantic plan amendment without changing the original binding or pinned policy",
		)
		.requiredOption("--run <id>", "Existing execution run")
		.requiredOption(
			"--human-step <step>",
			"Coupled human:review-governance step (journal key, run-qualified step key, or local numeric id)",
		)
		.requiredOption(
			"--approval-step <step>",
			"Coupled plan reviewer step in this execution run",
		)
		.requiredOption(
			"--from-phase <phase>",
			"Earliest affected phase; must equal the assessment",
		)
		.option(
			"--resolves <finding>",
			"Finding id on the authorization source observation, or phase/observation-id/finding-id. Repeatable",
			collect,
			[],
		)
		.option("--dry-run", "Validate and preview without appending the amendment")
		.addHelpText(
			"after",
			"\n--human-step selects the coupled authorize_amendment decision. A generic human:gate, continue, or override does not qualify. Plain --resolves selects only the source observation. The requested set must equal the assessment and be covered by amendmentScope.resolutionRefs. Removing --dry-run records the paired receipt. Registration does not authorize implementation completion.\n",
		)
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(
				await amendImplementationPlanCommand(
					{
						runId,
						humanStep: opts.humanStep,
						approvalStep: opts.approvalStep,
						fromPhase: opts.fromPhase,
						resolves: opts.resolves,
						dryRun: opts.dryRun,
					},
					context,
				),
			);
		});

	review
		.command("migrate-schema")
		.description(
			"Record a schema 0 to schema 1 migration. Equivalent mode is a mechanical proof. Selective mode confirms the operator exclusion digest. There is no snapshot flag. Works on a completed plan-review run without reopening it.",
		)
		.requiredOption(
			"--run <id>",
			"Bound execution run or approved plan-review run",
		)
		.option(
			"--commit <sha>",
			"Full sha of the schema 1 plan commit (required unless --prepare)",
		)
		.requiredOption("--mode <mode>", "equivalent or selective")
		.option(
			"--prepare",
			"Prove the schema 1 target and commit only the plan file; records nothing. Equivalent writes the mechanical wrap; selective checks the file the operator edited",
		)
		.option(
			"--dry-run",
			"Print exclusions, non-governing text, and the digest without writing",
		)
		.option(
			"--confirm-exclusions <digest>",
			"Operator confirmation of the selective exclusion digest",
		)
		.option(
			"--no-checkpoint",
			"Leave the run's records uncommitted after recording",
		)
		.addHelpText(
			"after",
			"\nFlow (equivalent mode keeps Version, Status, and Revision History governing;\n" +
				"a run records one migration, so choose the mode before preparing):\n" +
				"  $ 5x review migrate-schema --run <id> --mode equivalent --prepare --dry-run\n" +
				"  $ 5x review migrate-schema --run <id> --mode equivalent --prepare\n" +
				"  $ 5x review migrate-schema --run <id> --mode equivalent --commit <sha> --dry-run\n" +
				"  $ 5x review migrate-schema --run <id> --mode equivalent --commit <sha>\n",
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
						prepare: opts.prepare,
						checkpoint: opts.checkpoint,
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
