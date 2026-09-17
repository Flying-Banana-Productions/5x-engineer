/**
 * Integration: `5x records backfill` dry-run, real commit, second-run
 * no-op, two-clone partial history union, and attribution output.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	decodeJsonlFile,
	parseRunJson,
} from "../../../src/control-plane/record-layout.js";
import {
	completeRun,
	createRunV1,
	recordStep,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
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

function initRepo(dir: string): { planPath: string } {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["branch", "-M", "main"], dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "alpha.md");
	writeFileSync(planPath, "# Alpha\n\n## Phase 1: P1\n\n- [x] task\n");
	writeFileSync(
		join(dir, ".gitattributes"),
		"docs/development/runs/**/*.jsonl merge=union\n",
	);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return { planPath };
}

function openDb(dir: string): Database {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);
	return db;
}

function seedHistorical(
	dir: string,
	opts: {
		runId: string;
		planPath: string;
		status?: "active" | "completed";
		steps: Array<{ name: string; phase: string; iteration: number }>;
		createdAt?: string;
	},
): void {
	const db = openDb(dir);
	try {
		createRunV1(db, { id: opts.runId, planPath: opts.planPath });
		if (opts.createdAt) {
			db.run("UPDATE runs SET created_at = ?1, updated_at = ?1 WHERE id = ?2", [
				opts.createdAt,
				opts.runId,
			]);
		}
		for (const step of opts.steps) {
			recordStep(db, {
				run_id: opts.runId,
				step_name: step.name,
				phase: step.phase,
				iteration: step.iteration,
				result_json: JSON.stringify({ ok: true, step: step.name }),
				session_id: "ses_should_drop",
				log_path: "/tmp/should-drop.log",
			});
		}
		if (opts.status === "completed") {
			completeRun(db, opts.runId, "completed");
			if (opts.createdAt) {
				db.run("UPDATE runs SET updated_at = ?1 WHERE id = ?2", [
					"2026-09-01 13:00:00",
					opts.runId,
				]);
			}
		}
	} finally {
		db.close();
	}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run5x(
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string | undefined>,
): CmdResult {
	const result = Bun.spawnSync(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...cleanGitEnv(), ...extraEnv },
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

function parseEnvelope(stdout: string): {
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code: string };
} {
	return JSON.parse(stdout) as {
		ok: boolean;
		data?: Record<string, unknown>;
		error?: { code: string };
	};
}

describe("records backfill (integration)", () => {
	test("dry-run mapping then real commit; second run is a no-op", async () => {
		const dir = makeTmpDir("5x-bf-int");
		const configHome = makeTmpDir("5x-bf-id");
		try {
			const { planPath } = initRepo(dir);
			seedHistorical(dir, {
				runId: "run_int",
				planPath,
				status: "completed",
				steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
			});
			const env = { FIVEX_CONFIG_HOME: configHome };
			const dry = run5x(dir, ["records", "backfill", "--dry-run"], env);
			expect(dry.exitCode).toBe(0);
			const dryEnv = parseEnvelope(dry.stdout);
			expect(dryEnv.ok).toBe(true);
			const dryData = dryEnv.data as {
				dry_run: boolean;
				mappings: Array<{
					run_id: string;
					target_branch: string;
					files: string[];
				}>;
				exported_by: {
					recorder: { installation_id: string };
					performer: { role?: string };
				};
			};
			expect(dryData.dry_run).toBe(true);
			expect(dryData.mappings[0]?.run_id).toBe("run_int");
			expect(dryData.mappings[0]?.target_branch).toBe("main");
			expect(
				existsSync(
					join(
						dir,
						"docs",
						"development",
						"runs",
						"alpha",
						"run_int",
						"run.json",
					),
				),
			).toBe(false);

			const real = run5x(dir, ["records", "backfill"], env);
			expect(real.exitCode).toBe(0);
			const realEnv = parseEnvelope(real.stdout);
			expect(realEnv.ok).toBe(true);
			const exporterId = (realEnv.data as typeof dryData).exported_by.recorder
				.installation_id;
			const runJson = join(
				dir,
				"docs",
				"development",
				"runs",
				"alpha",
				"run_int",
				"run.json",
			);
			expect(existsSync(runJson)).toBe(true);
			const summary = parseRunJson(readFileSync(runJson, "utf-8"));
			expect(summary.creator).toBeNull();
			expect(summary.sealer).toBeNull();
			expect(summary.materializer?.recorder.installation_id).toBe(exporterId);
			expect(summary.materializer?.performer.role).toBe("exporter");
			const stepsText = readFileSync(
				join(
					dir,
					"docs",
					"development",
					"runs",
					"alpha",
					"run_int",
					"steps.jsonl",
				),
				"utf-8",
			);
			expect(stepsText).toContain('"origin":null');
			expect(stepsText).not.toContain("ses_should_drop");
			const lines = decodeJsonlFile(stepsText, "run_int");
			expect(lines[0]?.origin).toBeNull();
			expect(lines[0]?.materializer?.recorder.installation_id).toBe(exporterId);
			expect(git(["log", "-1", "--format=%s"], dir)).toBe(
				"5x: backfill records",
			);

			const head = git(["rev-parse", "HEAD"], dir);
			const second = run5x(dir, ["records", "backfill"], env);
			expect(second.exitCode).toBe(0);
			const secondData = parseEnvelope(second.stdout).data as {
				mappings: Array<{
					disagreements: unknown[];
					lines: Array<{ created: boolean }>;
				}>;
				commits: Array<{ created: boolean }>;
			};
			expect(secondData.mappings[0]?.disagreements).toEqual([]);
			expect(secondData.mappings[0]?.lines.every((l) => !l.created)).toBe(true);
			expect(secondData.commits[0]?.created).toBe(false);
			expect(git(["rev-parse", "HEAD"], dir)).toBe(head);

			const state = run5x(dir, ["run", "state", "--run", "run_int"], env);
			expect(state.exitCode).toBe(0);
			const stateData = parseEnvelope(state.stdout).data as {
				creator: unknown;
				sealer?: unknown;
				exported_by?: { recorder: { installation_id: string } };
			};
			expect(stateData.creator).toBeNull();
			expect(stateData.sealer).toBeNull();
			expect(stateData.exported_by?.recorder.installation_id).toBe(exporterId);
			const stateText = run5x(
				dir,
				["--text", "run", "state", "--run", "run_int"],
				env,
			);
			expect(stateText.stdout).toContain("creator: (unknown)");
			expect(stateText.stdout).toContain("sealer: (unknown)");
			expect(stateText.stdout).toContain(`exported_by: ${exporterId}`);
			const creatorLine = stateText.stdout
				.split("\n")
				.find((l) => l.startsWith("creator:"));
			expect(creatorLine).not.toContain(exporterId);

			const list = run5x(dir, ["plan", "list"], env);
			expect(list.exitCode).toBe(0);
			const listData = parseEnvelope(list.stdout).data as {
				plans: Array<{
					creator?: unknown;
					sealer?: unknown;
					exported_by?: { recorder: { installation_id: string } };
				}>;
			};
			const plan = listData.plans[0];
			expect(plan?.creator).toBeNull();
			expect(plan?.exported_by?.recorder.installation_id).toBe(exporterId);
			const listText = run5x(dir, ["--text", "plan", "list"], env);
			expect(listText.stdout).toContain("creator: (unknown)");
			expect(listText.stdout).not.toMatch(new RegExp(`creator: ${exporterId}`));
		} finally {
			cleanupDir(dir);
			cleanupDir(configHome);
		}
	});

	test("two clones with partial history merge=union all keys", async () => {
		const origin = makeTmpDir("5x-bf-origin");
		const cloneA = makeTmpDir("5x-bf-a");
		const cloneB = makeTmpDir("5x-bf-b");
		const idA = makeTmpDir("5x-bf-id-a");
		const idB = makeTmpDir("5x-bf-id-b");
		try {
			initRepo(origin);
			cleanupDir(cloneA);
			cleanupDir(cloneB);
			git(["clone", origin, cloneA], tmpdir());
			git(["clone", origin, cloneB], tmpdir());
			git(["config", "user.email", "a@test.com"], cloneA);
			git(["config", "user.name", "A"], cloneA);
			git(["config", "user.email", "b@test.com"], cloneB);
			git(["config", "user.name", "B"], cloneB);
			mkdirSync(join(cloneA, ".5x"), { recursive: true });
			mkdirSync(join(cloneB, ".5x"), { recursive: true });
			const planA = join(cloneA, "docs", "development", "alpha.md");
			const planB = join(cloneB, "docs", "development", "alpha.md");
			seedHistorical(cloneA, {
				runId: "run_shared",
				planPath: planA,
				status: "active",
				createdAt: "2026-09-01 12:00:00",
				steps: [
					{ name: "author:p1", phase: "1", iteration: 1 },
					{ name: "author:p2", phase: "2", iteration: 1 },
					{ name: "author:p3", phase: "3", iteration: 1 },
				],
			});
			seedHistorical(cloneB, {
				runId: "run_shared",
				planPath: planB,
				status: "active",
				createdAt: "2026-09-01 12:00:00",
				steps: [
					{ name: "author:p4", phase: "4", iteration: 1 },
					{ name: "author:p5", phase: "5", iteration: 1 },
				],
			});
			const a = run5x(cloneA, ["records", "backfill"], {
				FIVEX_CONFIG_HOME: idA,
			});
			expect(a.exitCode).toBe(0);
			const b = run5x(cloneB, ["records", "backfill"], {
				FIVEX_CONFIG_HOME: idB,
			});
			expect(b.exitCode).toBe(0);
			git(["remote", "add", "peer", cloneB], cloneA);
			git(["fetch", "peer"], cloneA);
			const merge = Bun.spawnSync(["git", "merge", "peer/main", "--no-edit"], {
				cwd: cloneA,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const stepsRel = "docs/development/runs/alpha/run_shared/steps.jsonl";
			const runRel = "docs/development/runs/alpha/run_shared/run.json";
			if (merge.exitCode !== 0) {
				if (existsSync(join(cloneA, `${runRel}`))) {
					try {
						git(["checkout", "--ours", "--", runRel], cloneA);
						git(["add", "--", runRel], cloneA);
					} catch {
						/* ignore */
					}
				}
				if (existsSync(join(cloneA, stepsRel))) {
					git(["add", "--", stepsRel], cloneA);
				}
				try {
					git(["commit", "-m", "merge backfill histories"], cloneA);
				} catch {
					/* merge may already have completed jsonl */
				}
			}
			const mergedText = readFileSync(join(cloneA, stepsRel), "utf-8");
			expect(mergedText).not.toContain("<<<<<<<");
			const decoded = decodeJsonlFile(mergedText, "run_shared");
			const keys = new Set(decoded.map((l) => l.idempotencyKey));
			expect(keys.has("step:run_shared:author:p1:1:1")).toBe(true);
			expect(keys.has("step:run_shared:author:p2:2:1")).toBe(true);
			expect(keys.has("step:run_shared:author:p3:3:1")).toBe(true);
			expect(keys.has("step:run_shared:author:p4:4:1")).toBe(true);
			expect(keys.has("step:run_shared:author:p5:5:1")).toBe(true);
			for (const line of decoded) {
				expect(line.origin).toBeNull();
				expect(line.materializer).toBeDefined();
			}
		} finally {
			cleanupDir(origin);
			cleanupDir(cloneA);
			cleanupDir(cloneB);
			cleanupDir(idA);
			cleanupDir(idB);
		}
	});
});
