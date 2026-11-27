import { describe, expect, test } from "bun:test";
import {
	hasUnresolvedSkillTokens,
	resolveSkillTokens,
	SKILL_TOKENS,
	type SkillTokenMap,
} from "../../../src/skills/harness-tokens.js";

const TOKENS: SkillTokenMap = {
	NATIVE_CONTINUE_PARAM: "sessionID",
	NATIVE_DELEGATE_TOOL: "`subagent` tool",
	NATIVE_AGENT_PARAM: "agent",
	NATIVE_LAUNCH_VAR: "LAUNCH",
	NATIVE_AWAIT_RESULT: "\nCHILD=<id from LAUNCH>\nRESULT=<report>",
	NATIVE_CHILD_ID_SOURCE: "$CHILD",
	NATIVE_CHILD_ID_NOUN: "child id",
	NATIVE_CHILD_ID_FROM: "`$CHILD`",
	NATIVE_AWAIT_NOTE: "",
};

describe("skill harness token resolver", () => {
	test("resolves known semantic tokens", () => {
		const rendered = resolveSkillTokens(
			"Use [[NATIVE_CONTINUE_PARAM]] for native continuation",
			TOKENS,
		);

		expect(rendered).toBe("Use sessionID for native continuation");
	});

	test("resolves the delegation and lifecycle tokens", () => {
		const rendered = resolveSkillTokens(
			"[[NATIVE_LAUNCH_VAR]]=<[[NATIVE_DELEGATE_TOOL]]: [[NATIVE_AGENT_PARAM]]=x>[[NATIVE_AWAIT_RESULT]]\nID=[[NATIVE_CHILD_ID_SOURCE]] ([[NATIVE_CHILD_ID_NOUN]] from [[NATIVE_CHILD_ID_FROM]])[[NATIVE_AWAIT_NOTE]]",
			TOKENS,
		);

		expect(rendered).toBe(
			"LAUNCH=<`subagent` tool: agent=x>\nCHILD=<id from LAUNCH>\nRESULT=<report>\nID=$CHILD (child id from `$CHILD`)",
		);
	});

	test("substitutes multi-line values unchanged and does not re-scan them", () => {
		const rendered = resolveSkillTokens("a[[NATIVE_AWAIT_RESULT]]b", {
			...TOKENS,
			NATIVE_AWAIT_RESULT: "\nline [[NOT_A_TOKEN]]\n# comment\n",
		});

		expect(rendered).toBe("a\nline [[NOT_A_TOKEN]]\n# comment\nb");
	});

	test("every declared token has a value in a complete map", () => {
		for (const name of Object.values(SKILL_TOKENS)) {
			expect(typeof TOKENS[name]).toBe("string");
		}
	});

	test("throws on missing token mapping", () => {
		expect(() => resolveSkillTokens("[[UNKNOWN_TOKEN]]", TOKENS)).toThrow(
			"Missing skill token mapping",
		);
		const partial = { NATIVE_CONTINUE_PARAM: "sessionID" } as SkillTokenMap;
		expect(() =>
			resolveSkillTokens("[[NATIVE_AWAIT_RESULT]]", partial),
		).toThrow("Missing skill token mapping for [[NATIVE_AWAIT_RESULT]]");
	});

	test("detects unresolved token placeholders", () => {
		expect(hasUnresolvedSkillTokens("[[NATIVE_CONTINUE_PARAM]]")).toBe(true);
		expect(hasUnresolvedSkillTokens("[[NATIVE_AWAIT_RESULT]]")).toBe(true);
		expect(hasUnresolvedSkillTokens("sessionID")).toBe(false);
	});
});
