import type { RecordOrigin } from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import {
	parseDeliveryBudget,
	rawDeliveryBudgetSection,
} from "../parsers/delivery-budget.js";
import type { ReviewBudgetConfig } from "./types.js";

export type EnsurePlanReviewBaselineResult =
	| { status: "skipped"; reason: "off" | "v1_compat" | "already" }
	| {
			status: "captured";
			baseline: NonNullable<ReturnType<ReviewBudgetStore["getBaseline"]>>;
	  }
	| { status: "error"; code: string; message: string };

export function ensurePlanReviewBaseline(input: {
	runId: string;
	planMarkdown: string;
	config: ReviewBudgetConfig;
	store: ReviewBudgetStore;
	hasPriorPlanReviewerStep: boolean;
	optIn: boolean;
	origin: RecordOrigin;
	warn: (message: string) => void;
}): EnsurePlanReviewBaselineResult {
	if (input.config.mode === "off") {
		return { status: "skipped", reason: "off" };
	}
	const existing = input.store.getBaseline(input.runId);
	if (existing) {
		if (input.optIn) {
			return {
				status: "error",
				code: "BUDGET_BASELINE_OPT_IN_INVALID",
				message:
					"A review budget baseline already exists; retry without --opt-in-budget-baseline",
			};
		}
		return { status: "skipped", reason: "already" };
	}
	if (input.optIn && !input.hasPriorPlanReviewerStep) {
		return {
			status: "error",
			code: "BUDGET_BASELINE_OPT_IN_INVALID",
			message:
				"--opt-in-budget-baseline is valid only after a plan-reviewer step has already been recorded",
		};
	}
	if (input.hasPriorPlanReviewerStep && !input.optIn) {
		return { status: "skipped", reason: "v1_compat" };
	}
	const parsed = parseDeliveryBudget(input.planMarkdown);
	if (!parsed.ok) {
		return {
			status: "error",
			code: parsed.code,
			message:
				parsed.code === "BUDGET_SECTION_MISSING"
					? `${parsed.message} Run an author preflight to add ## Delivery Budget before the first reviewer.`
					: parsed.message,
		};
	}
	const { mode: _mode, ...configSnapshot } = input.config;
	const result = input.store.captureBaseline({
		runId: input.runId,
		captureKind: input.optIn ? "opt_in" : "initial",
		parsed: parsed.value,
		originalSection: rawDeliveryBudgetSection(input.planMarkdown) ?? undefined,
		configSnapshot,
		origin: input.origin,
	});
	if (result.created && input.config.mode === "enforced") {
		input.warn(
			"reviewBudget.mode is enforced but enforcement is not implemented; recording advisory telemetry only",
		);
	}
	return result.created
		? { status: "captured", baseline: result.baseline }
		: { status: "skipped", reason: "already" };
}
