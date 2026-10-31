/**
 * Call-site helpers for authority reads.
 *
 * `parsePlan` and `parseDeliveryBudget` keep their signatures. Callers that
 * enforce authority pass `authorityMarkdown`. Schema 1 display status and
 * human version come from the raw preamble, not the mask.
 */

import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { type ParsedPlan, parsePlan } from "../parsers/plan.js";
import {
	authoritativePlan,
	type ExpectedPlanSchema,
	type LoadedPlanDocument,
	type LoadPlanDocumentResult,
	readPlanPreamble,
} from "./document.js";

export { authoritativePlan };

const PLAN_SCHEMA_RECOVERY_POINTER =
	"See 5x review migrate-schema --help and the 5x-plan-migration skill.";

export function planSchemaCommandMessage(failure: { message: string }): string {
	const legacy = failure.message.includes("not a legacy fallback")
		? failure.message
		: `${failure.message} This is not a legacy fallback.`;
	if (
		legacy.includes("5x review migrate-schema --help") &&
		legacy.includes("5x-plan-migration")
	) {
		return legacy;
	}
	return `${legacy} ${PLAN_SCHEMA_RECOVERY_POINTER}`;
}

export function readAuthoritativePlan(
	raw: string,
	expected: ExpectedPlanSchema,
):
	| { ok: true; plan: ParsedPlan; document: LoadedPlanDocument }
	| Extract<LoadPlanDocumentResult, { ok: false }> {
	const loaded = authoritativePlan(raw, expected);
	if (!loaded.ok) return loaded;
	const plan = parsePlan(loaded.document.authorityMarkdown);
	if (loaded.document.schema === 1) {
		const preamble = readPlanPreamble(raw);
		plan.version = preamble.version;
		plan.status = preamble.status;
	}
	return { ok: true, plan, document: loaded.document };
}

export function readAuthoritativeBudget(
	raw: string,
	expected: ExpectedPlanSchema,
) {
	const loaded = authoritativePlan(raw, expected);
	if (!loaded.ok) return loaded;
	return {
		ok: true as const,
		document: loaded.document,
		parsed: parseDeliveryBudget(loaded.document.authorityMarkdown),
	};
}
