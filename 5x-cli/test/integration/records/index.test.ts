/**
 * Integration: `5x records index` on a fresh clone materializes SQLite
 * `runs` / `steps` from git records (modulo ids and local-only columns).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRunJson } from "../../../src/control-plane/record-layout.js";
import { getRunV1, getSteps } from "../../../src/db/operations-v1.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix: string): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function git(args: string[], cwd: string): string {
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
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["branch", "-M", "main"], dir);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
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

function seedCommittedRecords(
	dir: string,
	opts?: { backfill?: boolean },
): void {
	mkdirSync(join(dir, "docs", "development", "runs", "alpha", "run_a"), {
		recursive: true,
	});
	writeFileSync(
		join(dir, "docs", "development", "alpha.md"),
		"# Alpha\n\n## Phase 1: P1\n\n- [x] task\n",
	);
	const summary: Record<string, unknown> = {
		id: "run_a",
		plan_path: "docs/development/alpha.md",
		config_json: null,
		created_at: "2026-09-01 12:00:00",
		sealed_at: opts?.backfill ? "2026-09-01 13:00:00" : null,
		status: opts?.backfill ? "completed" : "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: 1,
		creator: opts?.backfill
			? null
			: { installation_id: "11111111-1111-4111-8111-111111111111" },
	};
	if (opts?.backfill) {
		summary.sealer = null;
		summary.materializer = {
			recorder: { installation_id: "22222222-2222-4222-8222-222222222222" },
			performer: { kind: "system", role: "exporter" },
		};
	}
	writeFileSync(
		join(dir, "docs", "development", "runs", "alpha", "run_a", "run.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	const line = {
		schema_version: 1,
		stream: "steps",
		idempotency_key: "step:run_a:author:impl:1:1",
		created_at: "2026-09-01 12:00:00",
		provenance: opts?.backfill ? "backfilled" : "recorded",
		origin: opts?.backfill
			? null
			: {
					recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
					performer: { kind: "system", role: "cli" },
				},
		payload: {
			step_name: "author:impl",
			phase: "1",
			iteration: 1,
			result_json: { ok: true, n: 1 },
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: 5,
			tokens_in: 1,
			tokens_out: 2,
			cost_usd: 0.01,
			model: "test",
		},
		...(opts?.backfill
			? {
					materializer: {
						recorder: {
							installation_id: "22222222-2222-4222-8222-222222222222",
						},
						performer: { kind: "system", role: "exporter" },
					},
				}
			: {}),
	};
	writeFileSync(
		join(dir, "docs", "development", "runs", "alpha", "run_a", "steps.jsonl"),
		`${JSON.stringify(line)}\n`,
	);
	git(["add", "-A"], dir);
	git(["commit", "-m", "records"], dir);
}

describe("5x records index (integration)", () => {
	test(
		"fresh clone materializes runs/steps modulo ids and local columns",
		() => {
			const origin = makeTmpDir("5x-idx-origin");
			const clone = join(
				tmpdir(),
				`5x-idx-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			try {
				initRepo(origin);
				seedCommittedRecords(origin);
				git(["clone", origin, clone], tmpdir());
				git(["config", "user.email", "test@test.com"], clone);
				git(["config", "user.name", "Test"], clone);

				const result = run5x(clone, ["records", "index"]);
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout) as {
					ok: boolean;
					data: {
						runs_upserted: number;
						steps_upserted: number;
						plans: string[];
					};
				};
				expect(envelope.ok).toBe(true);
				expect(envelope.data.runs_upserted).toBe(1);
				expect(envelope.data.steps_upserted).toBe(1);
				expect(envelope.data.plans).toContain("alpha");

				const db = new Database(join(clone, ".5x", "5x.db"), {
					readonly: true,
				});
				const run = getRunV1(db, "run_a");
				expect(run).not.toBeNull();
				expect(run?.status).toBe("active");
				const steps = getSteps(db, "run_a");
				expect(steps).toHaveLength(1);
				expect(steps[0]?.step_name).toBe("author:impl");
				expect(steps[0]?.phase).toBe("1");
				expect(steps[0]?.iteration).toBe(1);
				expect(JSON.parse(steps[0]?.result_json ?? "{}")).toEqual({
					ok: true,
					n: 1,
				});
				expect(steps[0]?.session_id).toBeNull();
				expect(steps[0]?.log_path).toBeNull();
				expect(steps[0]?.model).toBe("test");
				expect(
					(steps[0] as unknown as Record<string, unknown>).origin,
				).toBeUndefined();
				db.close();

				const second = run5x(clone, ["records", "index"]);
				expect(second.exitCode).toBe(0);
				const again = JSON.parse(second.stdout) as {
					data: { runs_upserted: number; steps_upserted: number };
				};
				expect(again.data.runs_upserted).toBe(0);
				expect(again.data.steps_upserted).toBe(0);
			} finally {
				cleanupDir(origin);
				cleanupDir(clone);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"backfilled creator null stays unknown after index",
		() => {
			const dir = makeTmpDir("5x-idx-backfill");
			try {
				initRepo(dir);
				seedCommittedRecords(dir, { backfill: true });
				const result = run5x(dir, ["records", "index"]);
				expect(result.exitCode).toBe(0);
				const db = new Database(join(dir, ".5x", "5x.db"), { readonly: true });
				const run = getRunV1(db, "run_a");
				expect(run?.status).toBe("completed");
				const summary = parseRunJson(
					readFileSync(
						join(dir, "docs/development/runs/alpha/run_a/run.json"),
						"utf8",
					),
				);
				expect(summary.creator).toBeNull();
				expect(summary.sealer).toBeNull();
				expect(summary.materializer).toBeTruthy();
				db.close();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--plan limits to one slug",
		() => {
			const dir = makeTmpDir("5x-idx-plan");
			try {
				initRepo(dir);
				seedCommittedRecords(dir);
				const result = run5x(dir, ["records", "index", "--plan", "alpha"]);
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout) as {
					data: { plans: string[] };
				};
				expect(envelope.data.plans).toEqual(["alpha"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"diverged record histories refuse indexing either side",
		() => {
			const dir = makeTmpDir("5x-idx-diverged");
			try {
				initRepo(dir);
				mkdirSync(join(dir, "docs", "development"), { recursive: true });
				writeFileSync(
					join(dir, "docs", "development", "alpha.md"),
					"# Alpha\n\n## Phase 1: P1\n\n- [ ] task\n",
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "plan"], dir);
				git(["checkout", "-b", "5x/alpha"], dir);
				seedCommittedRecords(dir);
				git(["checkout", "-B", "right-tmp", "HEAD~1"], dir);
				mkdirSync(join(dir, "docs", "development", "runs", "alpha", "run_b"), {
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
						"run_b",
						"run.json",
					),
					`${JSON.stringify(
						{
							id: "run_b",
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
						"run_b",
						"steps.jsonl",
					),
					`${JSON.stringify({
						schema_version: 1,
						stream: "steps",
						idempotency_key: "step:run_b:right:only:1:1",
						created_at: "2026-09-01 12:00:00",
						provenance: "recorded",
						origin: {
							recorder: {
								installation_id: "11111111-1111-4111-8111-111111111111",
							},
							performer: { kind: "system", role: "cli" },
						},
						payload: {
							step_name: "right:only",
							phase: "1",
							iteration: 1,
							result_json: { ok: true },
						},
					})}\n`,
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "right records"], dir);
				const rightSha = git(["rev-parse", "HEAD"], dir);
				git(["update-ref", "refs/remotes/origin/5x/alpha", rightSha], dir);
				git(["checkout", "5x/alpha"], dir);

				const result = run5x(dir, ["records", "index"]);
				expect(result.exitCode).not.toBe(0);
				const envelope = JSON.parse(result.stdout) as {
					ok: boolean;
					error?: { code?: string };
				};
				expect(envelope.ok).toBe(false);
				expect(envelope.error?.code).toBe("RECORD_PROGRESS_DIVERGED");

				const db = new Database(join(dir, ".5x", "5x.db"), {
					readonly: true,
				});
				expect(getRunV1(db, "run_a")).toBeNull();
				expect(getRunV1(db, "run_b")).toBeNull();
				db.close();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
