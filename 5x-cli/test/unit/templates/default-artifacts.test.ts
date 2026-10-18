import { describe, expect, test } from "bun:test";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import { parsePlan } from "../../../src/parsers/plan.js";
import { parseReviewSummary } from "../../../src/parsers/review.js";
import {
	DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
	DEFAULT_REVIEW_TEMPLATE,
} from "../../../src/templates/default-artifacts.js";

// Preserve line positions so parser outputs can be compared including source locations.
function withoutComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, (comment) =>
		comment.replace(/[^\r\n]/g, ""),
	);
}

function example(text: string, label: string): string {
	const line = text.split("\n").find((entry) => entry.startsWith(`${label}: `));
	if (!line) throw new Error(`Missing ${label}`);
	return line.slice(label.length + 2);
}

describe("annotated artifact parser compatibility", () => {
	for (const claim of [false, true]) {
		test(`plan examples parse without phantom content (claim=${claim})`, () => {
			let plan = DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE.replace(
				/^\| W1 .*$/m,
				example(
					DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
					claim ? "Example negative row" : "Example row",
				),
			)
				.replace("{low | medium | high}", "high")
				.replace("{phase-N}", "phase-2")
				.replace("{0 or 1\\|2\\|3\\|5\\|8}", "1")
				.replace("{0 or ±1/2/3/5}", "0")
				.replace(
					"{concrete pre-state}",
					"Two callers own duplicate serializers",
				)
				.replace(
					"{concrete simpler post-state}",
					"Both callers use one serializer",
				)
				.replaceAll("{n}", "1");
			if (!claim) {
				plan = plan.replace(
					/### Debt Claims[\s\S]*?(?=### Surface Snapshot)/,
					"",
				);
			}
			const parsed = parsePlan(plan);
			expect(parsed).toEqual(parsePlan(withoutComments(plan)));
			expect(parsed.phases.map((phase) => phase.number)).toEqual(["1", "2"]);
			expect(parsed.phases.map((phase) => phase.items.length)).toEqual([2, 2]);
			const budget = parseDeliveryBudget(plan);
			expect(budget.ok).toBe(true);
			expect(budget).toEqual(parseDeliveryBudget(withoutComments(plan)));
			if (!budget.ok) throw new Error(budget.message);
			expect(budget.value.workItems).toHaveLength(1);
			expect(budget.value.workItems[0]?.id).toBe(claim ? "W2" : "W1");
			expect(budget.value.workItems[0]?.debtClaim?.debtClaimId).toBe(
				claim ? "DC0" : undefined,
			);
		});
	}

	test("review examples do not count as actual findings or override readiness", () => {
		const review = DEFAULT_REVIEW_TEMPLATE.replaceAll("{n}", "1").replace(
			"{Ready | Ready with corrections | Not ready}",
			"Not ready",
		);
		const parsed = parseReviewSummary(review);
		expect(parsed).toEqual(parseReviewSummary(withoutComments(review)));
		expect(parsed.p0Count).toBe(1);
		expect(parsed.p1Count).toBe(1);
		expect(parsed.p2Count).toBe(1);
		expect(parsed.readiness).toStartWith("Not ready");
	});
});
