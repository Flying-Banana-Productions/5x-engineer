import type { Command } from "@commander-js/extra-typings";
import { outputError, outputSuccess } from "../output.js";
import { resolveDbContext } from "./context.js";
import { createReviewBudgetContext } from "./review-budget-context.js";
import {
	type SubmitPlanReviewDecisionPayload,
	showPlanReviewGate,
	submitPlanReviewDecision,
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
	const context = await createReviewBudgetContext({ runId, dbContext });
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
		.action(async (opts) => {
			const { runId, context } = await contextFor(opts.run);
			outputSuccess(await showPlanReviewGate(runId, { context }));
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
				await submitPlanReviewDecision(
					{ runId, gateId: opts.gate, payload, findingIds },
					{ context },
				),
			);
		});
}
