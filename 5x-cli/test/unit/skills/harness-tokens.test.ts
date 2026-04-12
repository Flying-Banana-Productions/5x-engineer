import { describe, expect, test } from "bun:test";
import {
	hasUnresolvedSkillTokens,
	resolveSkillTokens,
} from "../../../src/skills/harness-tokens.js";

describe("skill harness token resolver", () => {
	test("resolves known semantic tokens", () => {
		const rendered = resolveSkillTokens(
			"Use [[NATIVE_CONTINUE_PARAM]] for native continuation",
			{ NATIVE_CONTINUE_PARAM: "task_id" },
		);

		expect(rendered).toBe("Use task_id for native continuation");
	});

	test("throws on missing token mapping", () => {
		expect(() =>
			resolveSkillTokens("[[UNKNOWN_TOKEN]]", {
				NATIVE_CONTINUE_PARAM: "task_id",
			}),
		).toThrow("Missing skill token mapping");
	});

	test("detects unresolved token placeholders", () => {
		expect(hasUnresolvedSkillTokens("[[NATIVE_CONTINUE_PARAM]]")).toBe(true);
		expect(hasUnresolvedSkillTokens("task_id")).toBe(false);
	});
});
