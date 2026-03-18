/**
 * Unit tests for session continuity validation (session-check.ts).
 *
 * Tests call validateSessionContinuity() directly with mock DB instances
 * and config objects. No subprocesses or CLI binary spawning.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	type SessionCheckOptions,
	validateSessionContinuity,
} from "../../../src/commands/session-check.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

function insertRun(db: Database, runId: string): void {
	db.run(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, 'docs/plan.md', 'active', '{}', datetime('now'), datetime('now'))`,
		[runId],
	);
}

function insertStep(
	db: Database,
	runId: string,
	stepName: string,
	phase: string | null,
): void {
	db.run(
		`INSERT INTO steps (run_id, step_name, phase, iteration, result_json, created_at)
		 VALUES (?1, ?2, ?3, 1, '{}', datetime('now'))`,
		[runId, stepName, phase],
	);
}

/** Build default options for tests. Config has continuePhaseSessions disabled by default. */
function baseOpts(
	overrides?: Partial<SessionCheckOptions>,
): SessionCheckOptions {
	return {
		templateName: "reviewer-plan",
		config: {
			author: { provider: "opencode", continuePhaseSessions: false },
			reviewer: { provider: "opencode", continuePhaseSessions: false },
		},
		...overrides,
	};
}

/** Config with continuePhaseSessions enabled for reviewer. */
function reviewerEnabledConfig() {
	return {
		author: { provider: "opencode", continuePhaseSessions: false },
		reviewer: { provider: "opencode", continuePhaseSessions: true },
	};
}

/** Config with continuePhaseSessions enabled for author. */
function authorEnabledConfig() {
	return {
		author: { provider: "opencode", continuePhaseSessions: true },
		reviewer: { provider: "opencode", continuePhaseSessions: false },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateSessionContinuity", () => {
	test("mutual exclusivity: both session and newSession → error", () => {
		expect(() =>
			validateSessionContinuity(
				baseOpts({ session: "sess_123", newSession: true }),
			),
		).toThrow(CliError);

		try {
			validateSessionContinuity(
				baseOpts({ session: "sess_123", newSession: true }),
			);
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
			expect((err as CliError).message).toContain("mutually exclusive");
		}
	});

	test("config disabled → no enforcement", () => {
		const db = makeDb();
		const runId = "run_001";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "plan");

		// Should NOT throw even with prior steps and no session flag
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId,
					db,
					// config has continuePhaseSessions: false by default
				}),
			),
		).not.toThrow();
	});

	test("no prior steps → no enforcement", () => {
		const db = makeDb();
		const runId = "run_002";
		insertRun(db, runId);
		// No prior steps

		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId,
					db,
					config: reviewerEnabledConfig(),
				}),
			),
		).not.toThrow();
	});

	test("prior steps exist, no flags, continued template exists → SESSION_REQUIRED error", () => {
		const db = makeDb();
		const runId = "run_003";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "plan");

		// reviewer-plan has a -continued variant (bundled)
		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId,
					db,
					config: reviewerEnabledConfig(),
				}),
			);
			expect(true).toBe(false); // should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("SESSION_REQUIRED");
			expect((err as CliError).message).toContain("session continuity");
			expect((err as CliError).message).toContain("--session");
			expect((err as CliError).message).toContain("--new-session");
		}
	});

	test("prior steps exist, no flags, no continued template → TEMPLATE_NOT_FOUND error", () => {
		const db = makeDb();
		const runId = "run_004";
		insertRun(db, runId);
		// reviewer-commit has no continued variant, step_name is "reviewer:review"
		insertStep(db, runId, "reviewer:review", "1");

		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-commit",
					runId,
					db,
					config: reviewerEnabledConfig(),
					explicitVars: { phase_number: "1" },
				}),
			);
			expect(true).toBe(false); // should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("TEMPLATE_NOT_FOUND");
			expect((err as CliError).message).toContain("reviewer-commit-continued");
		}
	});

	test("prior steps exist, session provided, continued template exists → no error", () => {
		const db = makeDb();
		const runId = "run_005";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "plan");

		// reviewer-plan has a continued variant
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					session: "sess_abc",
					runId,
					db,
					config: reviewerEnabledConfig(),
				}),
			),
		).not.toThrow();
	});

	test("prior steps exist, session provided, no continued template → TEMPLATE_NOT_FOUND error", () => {
		const db = makeDb();
		const runId = "run_006";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "1");

		// reviewer-commit has no continued variant
		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-commit",
					session: "sess_xyz",
					runId,
					db,
					config: reviewerEnabledConfig(),
					explicitVars: { phase_number: "1" },
				}),
			);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("TEMPLATE_NOT_FOUND");
		}
	});

	test("prior steps exist, newSession → no error (skips continued-template check)", () => {
		const db = makeDb();
		const runId = "run_007";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "plan");

		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					newSession: true,
					runId,
					db,
					config: reviewerEnabledConfig(),
				}),
			),
		).not.toThrow();
	});

	test("newSession bypasses even when no continued template exists", () => {
		const db = makeDb();
		const runId = "run_008";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "1");

		// reviewer-commit has NO continued variant, but --new-session should still pass
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-commit",
					newSession: true,
					runId,
					db,
					config: reviewerEnabledConfig(),
					explicitVars: { phase_number: "1" },
				}),
			),
		).not.toThrow();
	});

	test("role inference from step_name prefix: reviewer:* → reviewer", () => {
		const db = makeDb();
		const runId = "run_role_01";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "plan");

		// reviewer-plan has step_name "reviewer:review" → role "reviewer"
		// Only reviewer config matters here
		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId,
					db,
					config: {
						author: { provider: "opencode", continuePhaseSessions: true },
						reviewer: { provider: "opencode", continuePhaseSessions: true },
					},
				}),
			);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as CliError).code).toBe("SESSION_REQUIRED");
		}
	});

	test("role inference from step_name prefix: author:* → author", () => {
		const db = makeDb();
		const runId = "run_role_02";
		insertRun(db, runId);
		insertStep(db, runId, "author:implement", "1");

		// author-next-phase has step_name "author:implement" → role "author"
		// Only author config matters
		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "author-next-phase",
					runId,
					db,
					config: authorEnabledConfig(),
					explicitVars: { phase_number: "1" },
				}),
			);
			expect(true).toBe(false);
		} catch (err) {
			// author-next-phase has no continued variant → TEMPLATE_NOT_FOUND
			expect((err as CliError).code).toBe("TEMPLATE_NOT_FOUND");
		}
	});

	test("phase derivation: plan-review template → 'plan'", () => {
		const db = makeDb();
		const runId = "run_phase_01";
		insertRun(db, runId);
		// Insert step with phase "plan"
		insertStep(db, runId, "reviewer:review", "plan");

		// reviewer-plan is a plan-review template → phase is auto-derived as "plan"
		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId,
					db,
					config: reviewerEnabledConfig(),
					// No phase_number in explicitVars
				}),
			);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as CliError).code).toBe("SESSION_REQUIRED");
			expect((err as CliError).message).toContain('phase "plan"');
		}
	});

	test("phase derivation: explicit phase_number", () => {
		const db = makeDb();
		const runId = "run_phase_02";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", "2");

		try {
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-commit",
					runId,
					db,
					config: reviewerEnabledConfig(),
					explicitVars: { phase_number: "2" },
				}),
			);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as CliError).code).toBe("TEMPLATE_NOT_FOUND");
			expect((err as CliError).message).toContain('phase "2"');
		}
	});

	test("no run context → no enforcement", () => {
		// No runId
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					config: reviewerEnabledConfig(),
				}),
			),
		).not.toThrow();

		// runId but no db
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-plan",
					runId: "run_xxx",
					config: reviewerEnabledConfig(),
				}),
			),
		).not.toThrow();
	});

	test("phase cannot be determined → no enforcement", () => {
		const db = makeDb();
		const runId = "run_nophase";
		insertRun(db, runId);
		insertStep(db, runId, "reviewer:review", null);

		// reviewer-commit is not a plan-review template, no phase_number in vars
		// Phase derivation returns null → skip enforcement
		expect(() =>
			validateSessionContinuity(
				baseOpts({
					templateName: "reviewer-commit",
					runId,
					db,
					config: reviewerEnabledConfig(),
					// No phase_number
				}),
			),
		).not.toThrow();
	});
});
