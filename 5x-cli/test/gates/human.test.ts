import { describe, expect, test } from "bun:test";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";

/**
 * Human gates are interactive (stdin/stdout). We test:
 * 1. Types are importable and correct
 * 2. Non-interactive fallback behavior is exercised by the orchestrator tests
 *    (which inject mock gate functions)
 *
 * Full interactive tests would require PTY simulation; we rely on the
 * orchestrator integration tests to validate gate integration.
 */

describe("human gate types", () => {
	test("PhaseSummary type is constructable", () => {
		const summary: PhaseSummary = {
			phaseNumber: "1",
			phaseTitle: "Foundation",
			commit: "abc123",
			qualityPassed: true,
			reviewVerdict: "ready",
			filesChanged: 5,
			duration: 30000,
		};

		expect(summary.phaseNumber).toBe("1");
		expect(summary.qualityPassed).toBe(true);
	});

	test("EscalationEvent type is constructable", () => {
		const event: EscalationEvent = {
			reason: "test escalation",
			items: [{ id: "p0-1", title: "Bug", reason: "critical" }],
			iteration: 3,
		};

		expect(event.items).toHaveLength(1);
		expect(event.iteration).toBe(3);
	});

	test("EscalationResponse variants", () => {
		const continueResp: EscalationResponse = {
			action: "continue",
			guidance: "fix the bug",
		};
		const approveResp: EscalationResponse = { action: "approve" };
		const abortResp: EscalationResponse = { action: "abort" };

		expect(continueResp.action).toBe("continue");
		expect(approveResp.action).toBe("approve");
		expect(abortResp.action).toBe("abort");
	});

	test("PhaseSummary with minimal fields", () => {
		const summary: PhaseSummary = {
			phaseNumber: "2",
			phaseTitle: "Adapters",
			qualityPassed: false,
		};

		expect(summary.commit).toBeUndefined();
		expect(summary.reviewVerdict).toBeUndefined();
	});
});
