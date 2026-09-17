import type { RecordOrigin } from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import {
	parseDeliveryBudget,
	rawDeliveryBudgetSection,
} from "../parsers/delivery-budget.js";
import type { ReviewBudgetConfig } from "./types.js";

export type EnsurePlanReviewBaselineResult =
	| {
			ok: true;
			baseline: NonNullable<ReturnType<ReviewBudgetStore["getBaseline"]>>;
	  }
	| { ok: false; code: string; message: string };

export function ensurePlanReviewBaseline(input: {
	runId: string;
	planMarkdown: string;
	config: ReviewBudgetConfig;
	store: ReviewBudgetStore;
	captureKind: "initial" | "opt_in";
	origin: RecordOrigin;
	warn: (message: string) => void;
}): EnsurePlanReviewBaselineResult {
	const existing = input.store.getBaseline(input.runId);
	if (existing) return { ok: true, baseline: existing };
	const parsed = parseDeliveryBudget(input.planMarkdown);
	if (!parsed.ok) {
		return { ok: false, code: parsed.code, message: parsed.message };
	}
	if (input.config.mode === "enforced") {
		input.warn(
			"reviewBudget.mode = enforced is reserved; recording advisory telemetry only",
		);
	}
	const { mode: _mode, ...configSnapshot } = input.config;
	const result = input.store.captureBaseline({
		runId: input.runId,
		captureKind: input.captureKind,
		parsed: parsed.value,
		originalSection: rawDeliveryBudgetSection(input.planMarkdown) ?? undefined,
		configSnapshot,
		origin: input.origin,
	});
	return { ok: true, baseline: result.baseline };
}
