import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../../src/config.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import { parsePlan } from "../../../src/parsers/plan.js";
import { parseReviewSummary } from "../../../src/parsers/review.js";
import {
	loadPlanDocument,
	PLAN_SCHEMA_AUTHORITY_INSTRUCTION,
} from "../../../src/plan-schema/document.js";
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

describe("schema 1 plan skeletons", () => {
	function expectSchema1Skeleton(raw: string, phases: string[]): void {
		const loaded = loadPlanDocument(raw, 1);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.document.schema).toBe(1);
		expect(loaded.document.authorityMarkdown.length).toBe(raw.length);
		const governing = loaded.document.governingLines.join("\n");
		expect(raw).toContain(PLAN_SCHEMA_AUTHORITY_INSTRUCTION);
		expect(governing).toContain("# {Feature/Change Title}");
		expect(governing).not.toContain("**Status:**");
		expect(governing).not.toContain("## Revision History");
		expect(
			loaded.document.governingLines.some((line) => line.includes("<!--")),
		).toBe(false);
		expect(
			parsePlan(loaded.document.authorityMarkdown).phases.map(
				(phase) => phase.number,
			),
		).toEqual(phases);
	}

	test("bundled skeleton keeps obligations inside the contract", () => {
		expectSchema1Skeleton(DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE, ["1", "2"]);
		expect(DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE).toContain(
			"<!-- 5x:plan-schema:1 -->",
		);
		expect(DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE).not.toContain(
			"A comment left inside the contract is governing text",
		);
		const loaded = loadPlanDocument(DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE, 1);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.document.notes.map((note) => note.id)).toEqual([
			"generator-design",
			"generator-budget",
			"generator-debt",
			"generator-checklist",
		]);
		const governing = loaded.document.governingLines.join("\n");
		expect(governing).not.toContain("Example row:");
		expect(governing).not.toContain("Explain the chosen approach");
		expect(governing).not.toContain("Write observable requirements");
		expect(loaded.document.comparisonBytes).not.toContain("Example row:");
	});

	test("configured paths.templates.plan resolves the schema 1 skeleton", async () => {
		const tmp = join(
			tmpdir(),
			`5x-plan-skeleton-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmp, { recursive: true });
		try {
			const relative = "docs/custom-plan-template.md";
			const absolute = join(tmp, relative);
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(absolute, DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE);
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths.templates]\nplan = "${relative}"\n`,
			);
			const { config } = await loadConfig(tmp, undefined, undefined, tmp);
			expect(config.paths.templates.plan).toBe(absolute);
			expectSchema1Skeleton(
				readFileSync(config.paths.templates.plan, "utf-8"),
				["1", "2"],
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("repo default plan skeleton is schema 1", () => {
		const path = resolve(
			import.meta.dir,
			"../../../../docs/_implementation_plan_template.md",
		);
		expectSchema1Skeleton(readFileSync(path, "utf-8"), ["1", "2"]);
	});
});
