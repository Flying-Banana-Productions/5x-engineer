/**
 * Unit tests for `protocolValidate` handler and `extractResult` envelope
 * auto-detection.
 *
 * These test the handler's orchestration logic (JSON parsing, envelope
 * unwrapping, --record arg validation) by calling the handler directly
 * with file-based input — no subprocesses needed.
 *
 * Pure schema validation is covered in protocol-helpers.test.ts.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isNumericPhaseRef,
	protocolValidate,
} from "../../../src/commands/protocol.handler.js";
import { validateStructuredOutput } from "../../../src/commands/protocol-helpers.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-pv-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Write JSON to a temp file and return the path. */
function writeInput(dir: string, data: unknown): string {
	const p = join(dir, "input.json");
	writeFileSync(p, JSON.stringify(data));
	return p;
}

/** Set up a minimal 5x project dir with git + DB (no subprocesses). */
function setupProjectDir(dir: string): void {
	// Git repo (minimal — only needs .git to exist for control-plane resolution)
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	mkdirSync(join(dir, ".5x"), { recursive: true });
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();

	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n',
	);

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function insertRun(dir: string, runId: string, planPath: string): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, ?2, 'active', '{}', datetime('now'), datetime('now'))`,
		[runId, planPath],
	);
	db.close();
}

// ===========================================================================
// Author validation (pure — no subprocess, no git)
// ===========================================================================

describe("protocol validate author (unit)", () => {
	test("valid author complete", () => {
		const r = validateStructuredOutput(
			{ result: "complete", commit: "abc123def" },
			"author",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const v = r.value as { result: string; commit: string };
			expect(v.result).toBe("complete");
			expect(v.commit).toBe("abc123def");
		}
	});

	test("require-commit defaults to true — complete without commit is rejected", () => {
		const r = validateStructuredOutput({ result: "complete" }, "author", {
			context: "test",
		});
		expect(r.ok).toBe(false);
	});

	test("no-require-commit allows complete without commit", () => {
		const r = validateStructuredOutput({ result: "complete" }, "author", {
			context: "test",
			requireCommit: false,
		});
		expect(r.ok).toBe(true);
	});

	test("valid needs_human with reason", () => {
		const r = validateStructuredOutput(
			{ result: "needs_human", reason: "Stuck on complex logic" },
			"author",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
	});

	test("rejects needs_human without reason", () => {
		const r = validateStructuredOutput({ result: "needs_human" }, "author", {
			context: "test",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_STRUCTURED_OUTPUT");
	});

	test("reads input from file via handler", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "def456",
			});
			// protocolValidate with file input doesn't need git — but it does
			// call outputSuccess which writes to stdout. We just verify it
			// doesn't throw.
			// Note: outputSuccess calls process.stdout.write — in test/setup.ts
			// console.log is silenced, but outputSuccess goes through directly.
			// We catch CliError to detect validation failures.
			await protocolValidate({ role: "author", input: inputPath });
			// If we get here, validation passed (outputSuccess was called)
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Reviewer validation (pure — no subprocess, no git)
// ===========================================================================

describe("protocol validate reviewer (unit)", () => {
	test("valid ready verdict", () => {
		const r = validateStructuredOutput(
			{ readiness: "ready", items: [] },
			"reviewer",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
	});

	test("valid not_ready with items", () => {
		const r = validateStructuredOutput(
			{
				readiness: "not_ready",
				items: [
					{
						id: "P0.1",
						title: "Missing test",
						action: "auto_fix",
						reason: "No tests for the new function",
					},
				],
			},
			"reviewer",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
	});

	test("warns (not rejects) not_ready with empty items", () => {
		const r = validateStructuredOutput(
			{ readiness: "not_ready", items: [] },
			"reviewer",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.warnings).toHaveLength(1);
			expect(r.warnings[0]).toContain("empty");
		}
	});

	test("normalizes item without action to human_required", () => {
		const r = validateStructuredOutput(
			{
				readiness: "ready_with_corrections",
				items: [
					{
						id: "P1.1",
						title: "Missing docs",
						reason: "Function lacks JSDoc",
					},
				],
			},
			"reviewer",
			{ context: "test" },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const items = (r.value as Record<string, unknown>).items as Array<
				Record<string, unknown>
			>;
			expect(items[0]?.action).toBe("human_required");
		}
	});
});

// ===========================================================================
// Auto-detect input format (extractResult via handler)
// ===========================================================================

describe("protocol validate — auto-detect input format (unit)", () => {
	test("unwraps outputSuccess envelope automatically", async () => {
		const dir = makeTmpDir();
		try {
			const envelope = {
				ok: true,
				data: {
					run_id: "run_abc",
					step_name: "author:implement",
					result: { result: "complete", commit: "abc123" },
					session_id: "sess_1",
					model: "test",
					duration_ms: 1000,
					tokens: { in: 100, out: 200 },
					cost_usd: 0.5,
					log_path: "/tmp/log",
				},
			};
			const inputPath = writeInput(dir, envelope);
			// Should not throw — envelope is unwrapped, inner result is valid
			await protocolValidate({ role: "author", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});

	test("treats raw JSON (no ok field) as direct structured output", async () => {
		const dir = makeTmpDir();
		try {
			const raw = {
				readiness: "ready",
				items: [],
				summary: "Looks good",
			};
			const inputPath = writeInput(dir, raw);
			await protocolValidate({ role: "reviewer", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Invalid input (pure)
// ===========================================================================

describe("protocol validate — invalid input (unit)", () => {
	test("rejects non-JSON input", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = join(dir, "bad.json");
			writeFileSync(inputPath, "not json at all");
			await expect(
				protocolValidate({ role: "author", input: inputPath }),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});

	test("rejects non-object input", () => {
		const r = validateStructuredOutput("just a string", "author", {
			context: "test",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_STRUCTURED_OUTPUT");
	});
});

// ===========================================================================
// --record arg validation (handler-level, needs project dir for DB)
// ===========================================================================

describe("protocol validate --record arg validation (unit)", () => {
	test("--record without --run fails with INVALID_ARGS", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await expect(
				protocolValidate({
					role: "author",
					input: inputPath,
					record: true,
					step: "test",
				}),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});

	test("--record without --step fails with INVALID_ARGS", async () => {
		const dir = makeTmpDir();
		try {
			setupProjectDir(dir);
			const planPath = join(dir, "docs", "development", "test-plan.md");
			mkdirSync(join(dir, "docs", "development"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			const runId = "run_rec002";
			insertRun(dir, runId, planPath);

			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await expect(
				protocolValidate({
					role: "author",
					input: inputPath,
					run: runId,
					record: true,
				}),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});

	test("--record with invalid run id fails with INVALID_ARGS", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await expect(
				protocolValidate({
					role: "author",
					input: inputPath,
					record: true,
					run: "../bad-traversal",
					step: "test",
				}),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Phase enforcement: --record requires deterministic phase
// ===========================================================================

describe("protocol validate --record phase enforcement (unit)", () => {
	test("--record without --phase and result without .phase → PHASE_REQUIRED", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			try {
				await protocolValidate({
					role: "author",
					input: inputPath,
					record: true,
					run: "run_phase001",
					step: "author:implement",
				});
				expect(true).toBe(false); // should not reach
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PHASE_REQUIRED");
			}
		} finally {
			cleanupDir(dir);
		}
	});

	test("--record with --phase and mismatched result.phase → PHASE_MISMATCH", async () => {
		const dir = makeTmpDir();
		try {
			// Result JSON includes a .phase field that doesn't match --phase
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
				phase: "3",
			});
			try {
				await protocolValidate({
					role: "author",
					input: inputPath,
					record: true,
					run: "run_phase002",
					step: "phase:complete",
					phase: "2",
				});
				expect(true).toBe(false); // should not reach
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PHASE_MISMATCH");
				expect((err as CliError).message).toContain('"2"');
				expect((err as CliError).message).toContain('"3"');
			}
		} finally {
			cleanupDir(dir);
		}
	});

	test("--record with result.phase but no --phase → passes prereqs (no error)", async () => {
		const dir = makeTmpDir();
		try {
			// Result includes phase — should be extracted as resolved phase.
			// Recording itself may fail (DB context depends on cwd) but
			// the phase resolution logic should not throw.
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
				phase: "3",
			});

			// Should not throw CliError — phase is resolved from result_json.
			// Recording is a side-effect; failure is logged to stderr, not thrown.
			await protocolValidate({
				role: "author",
				input: inputPath,
				record: true,
				run: "run_phase003",
				step: "phase:complete",
				phaseChecklistValidate: false,
			});
		} finally {
			// Recording side-effect failure sets process.exitCode = 1; reset
			// to avoid poisoning the test runner exit code.
			process.exitCode = 0;
			cleanupDir(dir);
		}
	});

	test("--record with matching --phase and result.phase → passes prereqs", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
				phase: "3",
			});

			// Both sources agree — should not throw
			await protocolValidate({
				role: "author",
				input: inputPath,
				record: true,
				run: "run_phase004",
				step: "phase:complete",
				phase: "3",
				phaseChecklistValidate: false,
			});
		} finally {
			process.exitCode = 0;
			cleanupDir(dir);
		}
	});

	test("--record with --phase only (no result.phase) → passes prereqs", async () => {
		const dir = makeTmpDir();
		try {
			// AuthorStatus has no .phase field — --phase is the sole source
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});

			// Should not throw — --phase provides the phase
			await protocolValidate({
				role: "author",
				input: inputPath,
				record: true,
				run: "run_phase005",
				step: "author:implement",
				phase: "2",
				phaseChecklistValidate: false,
			});
		} finally {
			process.exitCode = 0;
			cleanupDir(dir);
		}
	});

	test("reviewer --record also enforces phase requirement", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				readiness: "ready",
				items: [],
			});
			try {
				await protocolValidate({
					role: "reviewer",
					input: inputPath,
					record: true,
					run: "run_phase006",
					step: "reviewer:commit",
				});
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PHASE_REQUIRED");
			}
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Phase 3: Legacy author status normalization via handler (016-review-artifacts)
// ===========================================================================

describe("protocol validate author with legacy status payloads (Phase 3)", () => {
	test("accepts legacy done status via file input and normalizes to complete", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				status: "done",
				commit: "legacy123",
				summary: "Legacy implementation complete",
			});
			// Should not throw — legacy payload is normalized and validated
			await protocolValidate({ role: "author", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});

	test("accepts legacy failed status with notes as reason fallback", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				status: "failed",
				notes: "Build failed due to dependency conflict",
			});
			await protocolValidate({ role: "author", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});

	test("accepts legacy needs_human status with summary as reason fallback", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				status: "needs_human",
				summary: "Need architecture decision",
			});
			await protocolValidate({ role: "author", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});

	test("validates normalized payload rejects done status without commit (commit is required)", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				status: "done",
				// missing commit — required since commit is mandatory for complete
			});
			await expect(
				protocolValidate({ role: "author", input: inputPath }),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});

	test("validates normalized payload still requires reason/notes for failed status", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				status: "failed",
				// missing reason, notes, and summary
			});
			await expect(
				protocolValidate({ role: "author", input: inputPath }),
			).rejects.toThrow(CliError);
		} finally {
			cleanupDir(dir);
		}
	});

	test("preserves canonical result payload unchanged", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "canonical456",
			});
			await protocolValidate({ role: "author", input: inputPath });
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Phase 4 (019-orchestrator-improvements): Checklist gate
// ===========================================================================

/** Create a plan file with the given phase checklist items. */
function writePlan(
	dir: string,
	phases: Array<{
		number: string;
		title: string;
		items: Array<{ text: string; checked: boolean }>;
	}>,
): string {
	const lines = ["# Test Plan\n", "**Version:** 1.0\n", "**Status:** Draft\n"];
	for (const phase of phases) {
		lines.push(`\n## Phase ${phase.number}: ${phase.title}\n`);
		lines.push("**Completion gate:** All items checked.\n");
		for (const item of phase.items) {
			lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
		}
		lines.push("");
	}
	const planPath = join(dir, "test-plan.md");
	writeFileSync(planPath, lines.join("\n"));
	return planPath;
}

describe("protocol validate author — checklist gate (unit)", () => {
	test("result: complete with --plan pointing to incomplete phase → PHASE_CHECKLIST_INCOMPLETE", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: false },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await expect(
				protocolValidate({
					role: "author",
					input: inputPath,
					plan: planPath,
					phase: "Phase 1: Setup",
				}),
			).rejects.toThrow(CliError);

			try {
				await protocolValidate({
					role: "author",
					input: inputPath,
					plan: planPath,
					phase: "Phase 1: Setup",
				});
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PHASE_CHECKLIST_INCOMPLETE");
			}
		} finally {
			cleanupDir(dir);
		}
	});

	test("result: complete with --plan pointing to complete phase → success", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: true },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Should not throw — phase is complete
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "Phase 1: Setup",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("result: complete with --no-phase-checklist-validate and incomplete phase → success", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: false },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Should not throw — checklist validation is suppressed
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "Phase 1: Setup",
				phaseChecklistValidate: false,
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("result: needs_human → no checklist check regardless", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Create config", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "needs_human",
				reason: "Stuck",
			});
			// Should not throw — checklist only fires for result: complete
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "Phase 1: Setup",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("reviewer role → no checklist check", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Create config", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				readiness: "ready",
				items: [],
			});
			// Should not throw — checklist gate is author-only
			await protocolValidate({
				role: "reviewer",
				input: inputPath,
				plan: planPath,
				phase: "Phase 1: Setup",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("no --plan and no --run → checklist check skipped, validation succeeds", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Should not throw — no plan to check
			await protocolValidate({
				role: "author",
				input: inputPath,
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("--plan with non-existent file → PLAN_NOT_FOUND (fail-closed)", async () => {
		const dir = makeTmpDir();
		try {
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			const fakePlanPath = join(dir, "nonexistent-plan.md");
			try {
				await protocolValidate({
					role: "author",
					input: inputPath,
					plan: fakePlanPath,
					phase: "Phase 1",
				});
				// Should not reach here
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PLAN_NOT_FOUND");
			}
		} finally {
			cleanupDir(dir);
		}
	});

	test("--plan with valid file but --phase not found → PHASE_NOT_FOUND (fail-closed)", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Create config", checked: true }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			try {
				await protocolValidate({
					role: "author",
					input: inputPath,
					plan: planPath,
					phase: "Phase 99: Nonexistent",
				});
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("PHASE_NOT_FOUND");
			}
		} finally {
			cleanupDir(dir);
		}
	});

	test("auto-discovered plan path (via --run) where file doesn't exist → graceful skip", async () => {
		const dir = makeTmpDir();
		try {
			setupProjectDir(dir);
			// Insert a run with a plan path that doesn't actually exist on disk
			const fakePlanPath = join(dir, "docs", "nonexistent-plan.md");
			const runId = "run_checklist001";
			insertRun(dir, runId, fakePlanPath);

			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});

			// Should not throw — auto-discovery fails open
			// Note: this test runs from the temp dir context, but the handler
			// uses resolveControlPlaneRoot() which uses cwd. Since we can't
			// change cwd in unit tests, the run context resolution may not
			// find the DB. Either way, auto-discovery should skip silently.
			await protocolValidate({
				role: "author",
				input: inputPath,
				run: runId,
				phase: "Phase 1",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("phase matched by 'Phase N' shorthand", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: true },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Match by "Phase 1" shorthand
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "Phase 1",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("phase matched by bare numeric string", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: true },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Match by bare "1" — the root cause of the phase:null bug
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "1",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("phase matched by title only", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [
						{ text: "Create config", checked: true },
						{ text: "Add tests", checked: true },
					],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// Match by title
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "Setup",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("non-numeric --phase 'plan' skips checklist gate (no PHASE_NOT_FOUND)", async () => {
		const dir = makeTmpDir();
		try {
			// Plan with incomplete checklist — would fail if gate fired
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Add tests", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			// --phase "plan" is a semantic identifier, not a plan phase reference.
			// The gate should skip — no PHASE_NOT_FOUND, no PHASE_CHECKLIST_INCOMPLETE.
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "plan",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("non-numeric --phase 'review' skips checklist gate", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Add tests", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "review",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("non-numeric --phase 'setup' skips checklist gate", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Add tests", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "setup",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("digit-bearing semantic --phase 'setup-v2' skips checklist gate", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Add tests", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "setup-v2",
			});
		} finally {
			cleanupDir(dir);
		}
	});

	test("digit-bearing semantic --phase 'review-2026' skips checklist gate", async () => {
		const dir = makeTmpDir();
		try {
			const planPath = writePlan(dir, [
				{
					number: "1",
					title: "Setup",
					items: [{ text: "Add tests", checked: false }],
				},
			]);
			const inputPath = writeInput(dir, {
				result: "complete",
				commit: "abc123",
			});
			await protocolValidate({
				role: "author",
				input: inputPath,
				plan: planPath,
				phase: "review-2026",
			});
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// isNumericPhaseRef (unit)
// ===========================================================================

describe("isNumericPhaseRef", () => {
	test("pure numeric: '1' → true", () => {
		expect(isNumericPhaseRef("1")).toBe(true);
	});

	test("decimal numeric: '2.1' → true", () => {
		expect(isNumericPhaseRef("2.1")).toBe(true);
	});

	test("'Phase 1' → true", () => {
		expect(isNumericPhaseRef("Phase 1")).toBe(true);
	});

	test("'Phase 2: Setup' → true", () => {
		expect(isNumericPhaseRef("Phase 2: Setup")).toBe(true);
	});

	test("'phase-1' → true", () => {
		expect(isNumericPhaseRef("phase-1")).toBe(true);
	});

	test("'Phase 99: Nonexistent' → true", () => {
		expect(isNumericPhaseRef("Phase 99: Nonexistent")).toBe(true);
	});

	test("'## Phase 1: Setup' (markdown heading) → true", () => {
		expect(isNumericPhaseRef("## Phase 1: Setup")).toBe(true);
	});

	test("'### Phase 2.1: Title' (markdown heading) → true", () => {
		expect(isNumericPhaseRef("### Phase 2.1: Title")).toBe(true);
	});

	test("'12' (multi-digit) → true", () => {
		expect(isNumericPhaseRef("12")).toBe(true);
	});

	test("'plan' → false", () => {
		expect(isNumericPhaseRef("plan")).toBe(false);
	});

	test("'review' → false", () => {
		expect(isNumericPhaseRef("review")).toBe(false);
	});

	test("'setup' → false", () => {
		expect(isNumericPhaseRef("setup")).toBe(false);
	});

	test("empty string → false", () => {
		expect(isNumericPhaseRef("")).toBe(false);
	});

	// Digit-bearing semantic labels should NOT match
	test("'setup-v2' → false (semantic label with digits)", () => {
		expect(isNumericPhaseRef("setup-v2")).toBe(false);
	});

	test("'review-2026' → false (semantic label with year)", () => {
		expect(isNumericPhaseRef("review-2026")).toBe(false);
	});

	test("'v2' → false (version-like semantic label)", () => {
		expect(isNumericPhaseRef("v2")).toBe(false);
	});

	test("'iteration3' → false (semantic label with trailing digit)", () => {
		expect(isNumericPhaseRef("iteration3")).toBe(false);
	});

	test("'pre-release-1.0' → false (semantic label)", () => {
		expect(isNumericPhaseRef("pre-release-1.0")).toBe(false);
	});
});
