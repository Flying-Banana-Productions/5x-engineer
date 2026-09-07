/**
 * Integration tests for `5x doctor` — CLI stdout/stderr, exit codes,
 * JSON envelope, `--fix` lock cleanup, and check isolation.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteInvocationStore } from "../../../src/control-plane/index.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { canonicalizePlanPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const DEAD_PID = 99999999;

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

function setupProject(dir: string, opts?: { db?: boolean }): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	if (opts?.db !== false) {
		const db = new Database(join(dir, ".5x", "5x.db"));
		runMigrations(db);
		db.close();
	}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run5x(cwd: string, args: string[]): CmdResult {
	const result = Bun.spawnSync(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
		exitCode: result.exitCode ?? 1,
	};
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

function reportOf(stdout: string): {
	ok: boolean;
	checks: Array<Record<string, unknown>>;
	fixed: Array<Record<string, unknown>>;
} {
	const envelope = parseJson(stdout);
	expect(envelope.ok).toBe(true);
	return envelope.data as {
		ok: boolean;
		checks: Array<Record<string, unknown>>;
		fixed: Array<Record<string, unknown>>;
	};
}

function canonicalLockPath(projectRoot: string, planPath: string): string {
	const canonical = canonicalizePlanPath(planPath);
	const hash = createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 16);
	return join(projectRoot, ".5x", "locks", `${hash}.lock`);
}

function writeLock(
	projectRoot: string,
	planPath: string,
	body: string | Record<string, unknown>,
	fileName?: string,
): string {
	const dir = join(projectRoot, ".5x", "locks");
	mkdirSync(dir, { recursive: true });
	const path = fileName
		? join(dir, fileName)
		: canonicalLockPath(projectRoot, planPath);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

describe("5x doctor (integration)", () => {
	test(
		"JSON envelope + eight check classes on a healthy project, exit 0",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = run5x(dir, ["doctor"]);
				expect(result.exitCode).toBe(0);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(true);
				const checks = report.checks.map((c) => c.check);
				expect(checks).toContain("harness-freshness");
				expect(checks).toContain("locks");
				expect(checks).toContain("worktrees");
				expect(checks).toContain("runs");
				expect(checks).toContain("db");
				expect(checks).toContain("prompts");
				expect(checks).toContain("invocations");
				expect(checks).toContain("records");
				expect(report.checks.some((c) => c.code === "DB_OK")).toBe(true);
				expect(report.checks.some((c) => c.code === "LOCKS_OK")).toBe(true);
				expect(report.checks.some((c) => c.code === "RUNS_OK")).toBe(true);
				expect(report.checks.some((c) => c.code === "PROMPTS_OK")).toBe(true);
				expect(report.checks.some((c) => c.code === "INVOCATIONS_OK")).toBe(
					true,
				);
				expect(report.checks.some((c) => c.code === "RECORD_INDEX_OK")).toBe(
					true,
				);
				expect(report.fixed).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--fix abandons a heartbeat-stale invocation without claiming a reap",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const db = new Database(join(dir, ".5x", "5x.db"));
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				const store = createSqliteInvocationStore(db);
				const created = store.register({
					runId: "run_live",
					sessionId: "sess-1",
					role: "author",
					providerName: "sample",
					templateName: "author",
					handle: { adapter: "none", ref: "sess-1" },
					cancellationSupported: false,
				});
				const stamp = new Date(Date.now() - 16 * 60 * 1000)
					.toISOString()
					.replace("T", " ")
					.slice(0, 19);
				db.query("UPDATE invocations SET updated_at = ?1 WHERE id = ?2").run(
					stamp,
					created.id,
				);
				db.close();

				const result = run5x(dir, ["doctor", "--fix"]);
				expect(result.exitCode).toBe(0);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(true);
				expect(
					report.fixed.some(
						(f) => f.check === "invocations" && f.code === "INVOCATION_STALE",
					),
				).toBe(true);
				expect(report.checks.some((c) => c.code === "INVOCATIONS_OK")).toBe(
					true,
				);

				const verify = new Database(join(dir, ".5x", "5x.db"), {
					readonly: true,
				});
				const row = verify
					.query("SELECT status, abandon_reason FROM invocations WHERE id = ?1")
					.get(created.id) as {
					status: string;
					abandon_reason: string | null;
				};
				verify.close();
				expect(row.status).toBe("abandoned");
				expect(row.abandon_reason).toBe("stale-metadata");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"text formatter prints check/status columns and remediation",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const plan = join(dir, "docs", "foo.md");
				writeLock(dir, plan, {
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(plan),
				});
				const result = run5x(dir, ["doctor", "--text"]);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain("locks");
				expect(result.stdout).toContain("fail");
				expect(result.stdout).toContain("→ 5x unlock");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--fix removes stale locks and path-addressed corrupt leftovers",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planA = join(dir, "docs", "a.md");
				const planB = join(dir, "docs", "b.md");
				const staleA = writeLock(dir, planA, {
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(planA),
				});
				const staleB = writeLock(dir, planB, {
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(planB),
				});
				const corrupt = writeLock(dir, "ignored", "{not-json", "leftover.lock");
				const livePlan = join(dir, "docs", "live.md");
				const live = writeLock(dir, livePlan, {
					pid: process.pid,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(livePlan),
				});

				const result = run5x(dir, ["doctor", "--fix"]);
				expect(result.exitCode).toBe(0);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(true);
				expect(
					report.fixed.filter((f) => f.code === "LOCK_STALE"),
				).toHaveLength(2);
				expect(report.fixed.some((f) => f.code === "LOCK_CORRUPT")).toBe(true);
				expect(existsSync(staleA)).toBe(false);
				expect(existsSync(staleB)).toBe(false);
				expect(existsSync(corrupt)).toBe(false);
				expect(existsSync(live)).toBe(true);
				expect(report.checks.some((c) => c.code === "LOCK_LIVE")).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unreadable DB isolates to DB findings; locks check still runs",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, { db: false });
				writeFileSync(join(dir, ".5x", "5x.db"), "not a sqlite database");
				const result = run5x(dir, ["doctor"]);
				expect(result.exitCode).toBe(1);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(false);
				expect(
					report.checks.some(
						(c) => c.check === "locks" && c.code === "LOCKS_OK",
					),
				).toBe(true);
				expect(
					report.checks.some(
						(c) => c.check === "db" && c.code === "DB_UNREADABLE",
					),
				).toBe(true);
				expect(report.checks.some((c) => c.code === "CHECK_FAILED")).toBe(
					false,
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"absent DB → DB_MISSING; --fix does not create the file",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, { db: false });
				const dbPath = join(dir, ".5x", "5x.db");
				expect(existsSync(dbPath)).toBe(false);
				const result = run5x(dir, ["doctor", "--fix"]);
				expect(result.exitCode).toBe(1);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(false);
				expect(report.checks.some((c) => c.code === "DB_MISSING")).toBe(true);
				expect(existsSync(dbPath)).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"lingering active run is warn-only (exit 0)",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const db = new Database(join(dir, ".5x", "5x.db"));
				db.query(
					`INSERT INTO runs (id, plan_path, status, created_at, updated_at)
					 VALUES (?1, ?2, 'active', ?3, ?3)`,
				).run(
					"run_old",
					canonicalizePlanPath(join(dir, "docs", "old.md")),
					"2020-01-01T00:00:00.000Z",
				);
				db.close();

				const result = run5x(dir, ["doctor"]);
				expect(result.exitCode).toBe(0);
				const report = reportOf(result.stdout);
				expect(report.ok).toBe(true);
				const lingering = report.checks.find((c) => c.code === "RUN_LINGERING");
				expect(lingering?.status).toBe("warn");
				expect(lingering?.fixable).toBe(false);
				expect(String(lingering?.remediation)).toContain(
					"5x run complete --run run_old --status aborted",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--help includes doctor examples",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = run5x(dir, ["doctor", "--help"]);
				expect(result.exitCode).toBe(0);
				const text = `${result.stdout}\n${result.stderr}`;
				expect(text).toContain("5x doctor --fix");
				expect(text).toContain("5x doctor --text");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"records drift is reported; --fix re-indexes; torn txn is not deleted",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				mkdirSync(join(dir, "docs", "development", "runs", "alpha", "run_a"), {
					recursive: true,
				});
				writeFileSync(
					join(dir, "docs", "development", "alpha.md"),
					"# Alpha\n\n## Phase 1: P1\n\n- [x] task\n",
				);
				writeFileSync(
					join(
						dir,
						"docs",
						"development",
						"runs",
						"alpha",
						"run_a",
						"run.json",
					),
					`${JSON.stringify(
						{
							id: "run_a",
							plan_path: "docs/development/alpha.md",
							config_json: null,
							created_at: "2026-09-01 12:00:00",
							sealed_at: null,
							status: "active",
							final_head_commit: null,
							cli_version: "1.3.0",
							format_version: 1,
							creator: {
								installation_id: "11111111-1111-4111-8111-111111111111",
							},
						},
						null,
						2,
					)}\n`,
				);
				writeFileSync(
					join(
						dir,
						"docs",
						"development",
						"runs",
						"alpha",
						"run_a",
						"steps.jsonl",
					),
					`${JSON.stringify({
						schema_version: 1,
						stream: "steps",
						idempotency_key: "step:run_a:author:impl:1:1",
						created_at: "2026-09-01 12:00:00",
						provenance: "recorded",
						origin: {
							recorder: {
								installation_id: "11111111-1111-4111-8111-111111111111",
							},
							performer: { kind: "system", role: "cli" },
						},
						payload: {
							step_name: "author:impl",
							phase: "1",
							iteration: 1,
							result_json: { ok: true },
							head_commit: null,
							patch_id: null,
							diff_summary: null,
							duration_ms: null,
							tokens_in: null,
							tokens_out: null,
							cost_usd: null,
							model: null,
						},
					})}\n`,
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "records"], dir);

				const detect = run5x(dir, ["doctor"]);
				expect(detect.exitCode).toBe(1);
				const detected = reportOf(detect.stdout);
				expect(
					detected.checks.some((c) => c.code === "RECORD_INDEX_MISSING_RUN"),
				).toBe(true);
				expect(
					detected.checks.some((c) => c.code === "RECORD_INDEX_MISSING_ROW"),
				).toBe(true);

				const fixed = run5x(dir, ["doctor", "--fix"]);
				expect(fixed.exitCode).toBe(0);
				const fixedReport = reportOf(fixed.stdout);
				expect(
					fixedReport.fixed.some(
						(f) =>
							f.check === "records" && f.code === "RECORD_INDEX_MISSING_RUN",
					),
				).toBe(true);
				expect(
					fixedReport.checks.some((c) => c.code === "RECORD_INDEX_MISSING_RUN"),
				).toBe(false);
				expect(
					fixedReport.checks.some((c) => c.code === "RECORD_INDEX_MISSING_ROW"),
				).toBe(false);

				const runDir = join(
					dir,
					"docs",
					"development",
					"runs",
					"alpha",
					"run_a",
				);
				writeFileSync(join(runDir, ".txn.commit"), "{");
				writeFileSync(join(runDir, ".txn.journal.json"), "{");
				const corrupt = run5x(dir, ["doctor", "--fix"]);
				expect(corrupt.exitCode).toBe(1);
				const corruptReport = reportOf(corrupt.stdout);
				expect(
					corruptReport.checks.some((c) => c.code === "RECORD_TXN_CORRUPT"),
				).toBe(true);
				expect(existsSync(join(runDir, ".txn.commit"))).toBe(true);
				expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
