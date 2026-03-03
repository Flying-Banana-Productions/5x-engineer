import { describe, expect, test } from "bun:test";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";
import { escalationGate } from "../../src/gates/human.js";

/**
 * Human gates are interactive (stdin/stdout). We test:
 * 1. Types are importable and correct
 * 2. Non-interactive fallback behavior (NODE_ENV=test → isInteractive() = false)
 *
 * Full interactive tests would require PTY simulation; we rely on the
 * TUI gate tests + orchestrator integration tests for interactive coverage.
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

	test("EscalationEvent with sessionId is constructable", () => {
		const event: EscalationEvent = {
			reason: "needs_human",
			iteration: 1,
			sessionId: "sess-abc-123",
		};

		expect(event.sessionId).toBe("sess-abc-123");
	});

	test("EscalationResponse variants", () => {
		const continueResp: EscalationResponse = {
			action: "continue",
			guidance: "fix the bug",
		};
		const continueSessionResp: EscalationResponse = {
			action: "continue_session",
			guidance: "try again",
		};
		const approveResp: EscalationResponse = { action: "approve" };
		const abortResp: EscalationResponse = { action: "abort" };

		expect(continueResp.action).toBe("continue");
		expect(continueSessionResp.action).toBe("continue_session");
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

// ---------------------------------------------------------------------------
// Non-interactive headless gate behavior
// ---------------------------------------------------------------------------

describe("headless escalation gate (non-interactive)", () => {
	// NODE_ENV=test → isInteractive() returns false → non-interactive path

	test("returns abort in non-interactive mode", async () => {
		const event: EscalationEvent = {
			reason: "Agent needs help",
			iteration: 1,
		};

		const result = await escalationGate(event);
		expect(result).toEqual({ action: "abort" });
	});

	test("returns abort even when sessionId is present (non-interactive)", async () => {
		const event: EscalationEvent = {
			reason: "Agent needs help",
			iteration: 1,
			sessionId: "sess-continuable-123",
		};

		const result = await escalationGate(event);
		// Non-interactive mode always aborts — it cannot prompt the user
		expect(result).toEqual({ action: "abort" });
	});
});
