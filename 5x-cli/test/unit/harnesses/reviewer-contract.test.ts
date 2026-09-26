import { expect, test } from "bun:test";
import { renderAgentTemplates as cursorAgents } from "../../../src/harnesses/cursor/loader.js";
import { renderAgentTemplates as opencodeAgents } from "../../../src/harnesses/opencode/loader.js";
import { assertReviewerVerdict } from "../../../src/protocol.js";

for (const [harness, render] of [
	["opencode", opencodeAgents],
	["cursor", cursorAgents],
] as const) {
	test(`${harness} native reviewer teaches a valid canonical response and preserves governance fields`, () => {
		const content =
			render({}).find((agent) => agent.name === "5x-reviewer")?.content ?? "";
		const example = /```json\n([\s\S]*?)\n```/.exec(content)?.[1];
		expect(example).toBeDefined();
		const verdict = JSON.parse(example as string);
		expect(() => assertReviewerVerdict(verdict, harness)).not.toThrow();
		expect(verdict).toHaveProperty("readiness");
		expect(verdict).not.toHaveProperty("verdict");
		for (const field of [
			"baselineAssessment",
			"creditAssessments",
			"priorFindings",
		]) {
			expect(content).toContain(field);
		}
		expect(content).toContain("raw canonical JSON verbatim");
		expect(content).toContain("5x protocol schema reviewer");
	});
}
