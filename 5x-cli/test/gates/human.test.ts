import { describe, expect, test } from "bun:test";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";
import { escalationGate } from "../../src/gates/human.js";
import { parseEscalationDecision } from "../../src/tui/gates.js";

/**
 * Human gates are interactive (stdin/stdout). We test:
 * 1. Types are importable and correct
 * 2. Non-interactive fallback behavior (NODE_ENV=test → isInteractive() = false)
 * 3. parseEscalationDecision unit tests (shared parsing logic)
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

// ---------------------------------------------------------------------------
// parseEscalationDecision unit tests (TUI parsing logic)
// ---------------------------------------------------------------------------

describe("parseEscalationDecision", () => {
	// --- approve / abort ---

	test("parses 'o' as approve", () => {
		expect(parseEscalationDecision("o")).toEqual({ action: "approve" });
	});

	test("parses 'approve' as approve", () => {
		expect(parseEscalationDecision("approve")).toEqual({ action: "approve" });
	});

	test("parses 'override' as approve", () => {
		expect(parseEscalationDecision("override")).toEqual({ action: "approve" });
	});

	test("parses 'q' as abort", () => {
		expect(parseEscalationDecision("q")).toEqual({ action: "abort" });
	});

	test("parses 'abort' as abort", () => {
		expect(parseEscalationDecision("abort")).toEqual({ action: "abort" });
	});

	// --- continue (fix / new session) ---

	test("parses 'f' as continue", () => {
		expect(parseEscalationDecision("f")).toEqual({ action: "continue" });
	});

	test("parses 'fix' as continue", () => {
		expect(parseEscalationDecision("fix")).toEqual({ action: "continue" });
	});

	test("parses 'continue' as continue (fix alias)", () => {
		expect(parseEscalationDecision("continue")).toEqual({
			action: "continue",
		});
	});

	test("parses 'continue: guidance text' with guidance", () => {
		const result = parseEscalationDecision("continue: fix the tests");
		expect(result?.action).toBe("continue");
		expect(result && "guidance" in result ? result.guidance : undefined).toBe(
			"fix the tests",
		);
	});

	test("parses 'fix: guidance text' with guidance", () => {
		const result = parseEscalationDecision("fix: update imports");
		expect(result?.action).toBe("continue");
		expect(result && "guidance" in result ? result.guidance : undefined).toBe(
			"update imports",
		);
	});

	// --- continue_session (only when canContinueSession) ---

	test("parses 'c' as continue_session when eligible", () => {
		expect(parseEscalationDecision("c", { canContinueSession: true })).toEqual({
			action: "continue_session",
		});
	});

	test("parses 'continue-session' as continue_session when eligible", () => {
		expect(
			parseEscalationDecision("continue-session", {
				canContinueSession: true,
			}),
		).toEqual({ action: "continue_session" });
	});

	test("parses 'c: guidance' as continue_session with guidance", () => {
		const result = parseEscalationDecision("c: try fixing the tests", {
			canContinueSession: true,
		});
		expect(result?.action).toBe("continue_session");
		expect(result && "guidance" in result ? result.guidance : undefined).toBe(
			"try fixing the tests",
		);
	});

	test("parses 'continue-session: guidance' with guidance", () => {
		const result = parseEscalationDecision("continue-session: check the logs", {
			canContinueSession: true,
		});
		expect(result?.action).toBe("continue_session");
		expect(result && "guidance" in result ? result.guidance : undefined).toBe(
			"check the logs",
		);
	});

	test("'c' is NOT parsed as continue_session when ineligible", () => {
		// When canContinueSession is false/absent, 'c' should return null
		// (invalid input), NOT be interpreted as continue_session
		const result = parseEscalationDecision("c");
		expect(result).toBeNull();
	});

	test("'c' with canContinueSession=false returns null", () => {
		const result = parseEscalationDecision("c", {
			canContinueSession: false,
		});
		expect(result).toBeNull();
	});

	test("'continue-session' when ineligible falls through to continue (not continue_session)", () => {
		// When canContinueSession is false, 'continue-session' is not handled
		// by the continue_session branch. It falls through to the 'continue'
		// regex which interprets the '-session' suffix as guidance.
		const result = parseEscalationDecision("continue-session");
		expect(result?.action).toBe("continue");
	});

	// --- unknown input ---

	test("returns null for unknown input", () => {
		expect(parseEscalationDecision("hello")).toBeNull();
		expect(parseEscalationDecision("")).toBeNull();
		expect(parseEscalationDecision("x")).toBeNull();
	});

	// --- whitespace handling ---

	test("trims whitespace", () => {
		expect(parseEscalationDecision("  f  ")).toEqual({ action: "continue" });
		expect(parseEscalationDecision("  q  ")).toEqual({ action: "abort" });
		expect(
			parseEscalationDecision("  c  ", { canContinueSession: true }),
		).toEqual({ action: "continue_session" });
	});

	test("case insensitive", () => {
		expect(parseEscalationDecision("F")).toEqual({ action: "continue" });
		expect(parseEscalationDecision("Q")).toEqual({ action: "abort" });
		expect(parseEscalationDecision("O")).toEqual({ action: "approve" });
		expect(parseEscalationDecision("C", { canContinueSession: true })).toEqual({
			action: "continue_session",
		});
		expect(
			parseEscalationDecision("Continue-Session", {
				canContinueSession: true,
			}),
		).toEqual({ action: "continue_session" });
	});
});
