import { describe, expect, test } from "bun:test";
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";

const contexts = [
	createRenderContext(true),
	createRenderContext(false),
	createRenderContext(false, true, false),
	createRenderContext(false, false, true),
];

describe("plan-review governance skill", () => {
	test("renders every governance route for native, invoke, and mixed installs", () => {
		for (const context of contexts) {
			const content = renderSkillByName("5x-plan-review", context).content;
			for (const route of [
				"complete",
				"author_revision",
				"final_corrections",
				"human_gate",
				"aborted",
			]) {
				expect(content).toContain(`\`${route}\``);
			}
			expect(content).toContain(".data.result.governance.route");
			expect(content).toContain("must not re-enter the reviewer");
			expect(content).toContain("maxReviewIterations");
		}
	});

	test("uses durable typed decisions rather than generic prompt answers", () => {
		for (const context of contexts) {
			const content = renderSkillByName("5x-plan-review", context).content;
			expect(content).toContain("5x review gate show");
			expect(content).toContain("5x review decide --gate");
			expect(content).toContain("requiredFieldsByChoice");
			expect(content).toContain('--finding "$FINDING_ID"');
			expect(content).toContain("--input-json -");
			expect(content).toContain("return `needs_human`");
			expect(content).toContain("Never resume from stale reviewer readiness");
		}
	});

	test("keeps advisory, off, and v1 compatibility on the legacy route", () => {
		const content = renderSkillByName(
			"5x-plan-review",
			createRenderContext(true),
		).content;
		expect(content).toContain("pinned advisory, mode off, and `v1_compat`");
		expect(content).toContain("Ignore advisory hypothetical routes");
		expect(content).toContain("legacy Step 4 escalation");
	});

	test("generated-plan workflow preserves the governed review branches", () => {
		for (const context of contexts) {
			const content = renderSkillByName("5x-plan", context).content;
			expect(content).toContain(".data.result.governance.route");
			expect(content).toContain("one-pass\n`final_corrections`");
			expect(content).toContain("successor `human_gate`");
			expect(content).toContain("never use");
			expect(content).toContain("generic `5x prompt`");
		}
	});
});
