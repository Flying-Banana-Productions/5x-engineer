/**
 * Unit tests for records backfill: target auto, dry-run, origin honesty,
 * disagreements, and idempotent second pass.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config.js";
import {
	createMemoryPromptStore,
	createWorkingTreeRecordStore,
	type RecordOrigin,
	type RecordPerformer,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
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
import { backfillRecords } from "../../../src/records/backfill.js";
import { resolveRecordsRoot } from "../../../src/records/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const EXPORTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function originFor(performer: RecordPerformer): RecordOrigin {
	return {
		recorder: { installation_id: EXPORTER_ID },
		performer: { kind: performer.kind, role: performer.role },
	};
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "5x-backfill-"));
	try {
		await fn(dir);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
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

function initRepo(dir: string, planName = "alpha.md"): string {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["branch", "-M", "main"], dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, planName);
	writeFileSync(planPath, "# Alpha\n\n## Phase 1: P1\n\n- [ ] task\n");
	writeFileSync(
		join(dir, ".gitattributes"),
		"docs/development/runs/**/*.jsonl merge=union\n",
	);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	mkdirSync(join(dir, ".5x"), { recursive: true });
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return planPath;
}

function openOwnedDb(dir: string): Database {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);
	return db;
}

function seedRun(
	db: Database,
	opts: {
		id: string;
		planPath: string;
		status?: "active" | "completed" | "aborted";
		steps: Array<{
			name: string;
			phase?: string;
			iteration: number;
			head_commit?: string | null;
			session_id?: string;
			log_path?: string;
		}>;
	},
): void {
	createRunV1(db, { id: opts.id, planPath: opts.planPath });
	for (const step of opts.steps) {
		recordStep(db, {
			run_id: opts.id,
			step_name: step.name,
			phase: step.phase,
			iteration: step.iteration,
			result_json: JSON.stringify({ ok: true, step: step.name }),
			head_commit: step.head_commit ?? undefined,
			session_id: step.session_id,
			log_path: step.log_path,
			duration_ms: 5,
			tokens_in: 1,
			tokens_out: 2,
			cost_usd: 0.01,
			model: "test",
		});
	}
	if (opts.status === "completed" || opts.status === "aborted") {
		completeRun(db, opts.id, opts.status);
	}
}

function runJsonPath(dir: string, slug: string, runId: string): string {
	return join(dir, "docs", "development", "runs", slug, runId, "run.json");
}

function stepsPath(dir: string, slug: string, runId: string): string {
	return join(dir, "docs", "development", "runs", slug, runId, "steps.jsonl");
}

describe("backfillRecords", () => {
	test("dry-run prints mapping and writes nothing", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_dry",
					planPath,
					steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const before = git(["status", "--porcelain"], dir);
				const result = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: true,
					originFor,
				});
				expect(result.dry_run).toBe(true);
				expect(result.mappings).toHaveLength(1);
				expect(result.mappings[0]?.run_id).toBe("run_dry");
				expect(result.mappings[0]?.target_branch).toBe("main");
				expect(
					result.mappings[0]?.files.some((f) => f.endsWith("run.json")),
				).toBe(true);
				expect(result.commits).toEqual([]);
				expect(existsSync(runJsonPath(dir, "alpha", "run_dry"))).toBe(false);
				expect(git(["status", "--porcelain"], dir)).toBe(before);
			} finally {
				db.close();
			}
		});
	});

	test("target auto uses 5x/<slug> when the branch exists", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			git(["checkout", "-b", "5x/alpha"], dir);
			git(["checkout", "main"], dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_branch",
					planPath,
					status: "completed",
					steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const result = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				expect(result.mappings[0]?.target_branch).toBe("5x/alpha");
				expect(result.commits[0]?.created).toBe(true);
				expect(result.commits[0]?.message).toContain("run_branch");
				const show = git(
					["show", "5x/alpha:docs/development/runs/alpha/run_branch/run.json"],
					dir,
				);
				const summary = parseRunJson(show);
				expect(summary.creator).toBeNull();
				expect(summary.sealer).toBeNull();
				expect(summary.materializer?.performer.role).toBe("exporter");
				expect(summary.backfilled).toBeUndefined();
				expect(existsSync(runJsonPath(dir, "alpha", "run_branch"))).toBe(false);
			} finally {
				db.close();
			}
		});
	});

	test("target auto falls back to the current branch when 5x/<slug> is gone", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_fallback",
					planPath,
					steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const result = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				expect(result.mappings[0]?.target_branch).toBe("main");
				expect(result.commits[0]?.message).toBe("5x: backfill records");
				const summary = parseRunJson(
					readFileSync(runJsonPath(dir, "alpha", "run_fallback"), "utf-8"),
				);
				expect(summary.status).toBe("active");
				expect(summary.backfilled).toBe(true);
				expect(summary.sealer).toBeUndefined();
				expect(summary.creator).toBeNull();
			} finally {
				db.close();
			}
		});
	});

	test("writes origin null, exporter materializer, and does not copy installation id into origin", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_origin",
					planPath,
					status: "completed",
					steps: [
						{
							name: "author:impl",
							phase: "1",
							iteration: 1,
							session_id: "ses_secret",
							log_path: "/tmp/secret.log",
						},
					],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				const text = readFileSync(
					stepsPath(dir, "alpha", "run_origin"),
					"utf-8",
				);
				expect(text).toContain('"origin":null');
				expect(text).not.toContain("ses_secret");
				expect(text).not.toContain("/tmp/secret.log");
				expect(text).not.toContain("hostname");
				expect(text).not.toContain("Test");
				const lines = decodeJsonlFile(text, "run_origin");
				expect(lines).toHaveLength(1);
				expect(lines[0]?.provenance).toBe("backfilled");
				expect(lines[0]?.origin).toBeNull();
				expect(lines[0]?.materializer?.recorder.installation_id).toBe(
					EXPORTER_ID,
				);
				expect(lines[0]?.materializer?.performer.role).toBe("exporter");
				expect(lines[0]?.origin).not.toEqual(lines[0]?.materializer);
				const payload = lines[0]?.payload as Record<string, unknown>;
				expect(payload.session_id).toBeUndefined();
				expect(payload.log_path).toBeUndefined();
				expect(payload.head_commit).toBeNull();

				const summary = parseRunJson(
					readFileSync(runJsonPath(dir, "alpha", "run_origin"), "utf-8"),
				);
				expect(summary.creator).toBeNull();
				expect(summary.sealer).toBeNull();
				expect(summary.materializer?.performer.role).toBe("exporter");
				expect(summary.materializer?.recorder.installation_id).toBe(
					EXPORTER_ID,
				);
			} finally {
				db.close();
			}
		});
	});

	test("second real run is a no-op: created false, no new commit", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_twice",
					planPath,
					steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const first = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				expect(first.commits[0]?.created).toBe(true);
				const head = git(["rev-parse", "HEAD"], dir);
				const second = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				expect(second.mappings[0]?.disagreements).toEqual([]);
				expect(second.mappings[0]?.lines.every((l) => !l.created)).toBe(true);
				expect(second.commits[0]?.created).toBe(false);
				expect(git(["rev-parse", "HEAD"], dir)).toBe(head);
				expect(git(["status", "--porcelain"], dir)).toBe("");
			} finally {
				db.close();
			}
		});
	});

	test("recorded-vs-backfill disagreement does not overwrite origin", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_live",
					planPath,
					steps: [{ name: "author:impl", phase: "1", iteration: 1 }],
				});
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const resolved = resolveRecordsRoot({
					recordsConfigAbs: config.paths.records,
					controlPlaneRoot: dir,
					effectiveWorkdir: dir,
				});
				const store = createWorkingTreeRecordStore({
					recordsRoot: resolved.recordsAbsPath,
				});
				const liveOrigin: RecordOrigin = {
					recorder: { installation_id: LIVE_ID },
					performer: { kind: "system", role: "cli" },
				};
				store.putRun({
					id: "run_live",
					plan_path: planPath.replace(/\\/g, "/"),
					config_json: null,
					created_at: "2026-09-01 12:00:00",
					sealed_at: null,
					status: "active",
					final_head_commit: null,
					cli_version: "1.3.0",
					format_version: RUN_RECORD_FORMAT_VERSION,
					creator: { installation_id: LIVE_ID },
				});
				const key = stepIdempotencyKey({
					runId: "run_live",
					stepName: "author:impl",
					phase: "1",
					iteration: 1,
				});
				store.append({
					runId: "run_live",
					stream: "steps",
					idempotencyKey: key,
					payload: {
						step_name: "author:impl",
						phase: "1",
						iteration: 1,
						result_json: { live: true },
						head_commit: null,
						patch_id: null,
						diff_summary: null,
						duration_ms: null,
						tokens_in: null,
						tokens_out: null,
						cost_usd: null,
						model: null,
					},
					...recordedEnvelope(liveOrigin),
				});

				const result = await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
				});
				expect(
					result.mappings[0]?.disagreements.some(
						(d) => d.reason === "recorded-vs-backfill",
					),
				).toBe(true);
				const line = store.getLine("run_live", "steps", key);
				expect(line?.provenance).toBe("recorded");
				expect(line?.origin?.recorder.installation_id).toBe(LIVE_ID);
				expect(line?.origin).not.toBeNull();
				const summary = store.getRun("run_live");
				expect(summary?.creator?.installation_id).toBe(LIVE_ID);
			} finally {
				db.close();
			}
		});
	});

	test("human steps and answered prompts become decision lines", async () => {
		await withTmp(async (dir) => {
			const planPath = initRepo(dir);
			const db = openOwnedDb(dir);
			try {
				seedRun(db, {
					id: "run_human",
					planPath,
					steps: [
						{ name: "human:approve", phase: "1", iteration: 1 },
						{ name: "author:impl", phase: "1", iteration: 1 },
					],
				});
				const prompts = createMemoryPromptStore();
				const prompt = prompts.createPrompt({
					id: "prompt_1",
					runId: "run_human",
					kind: "confirm",
					message: "Continue?",
				});
				prompts.answerPrompt(prompt.id, "true", "terminal");
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				await backfillRecords({
					db,
					config,
					workdir: dir,
					target: "auto",
					dryRun: false,
					originFor,
					promptStore: prompts,
				});
				const decisions = readFileSync(
					join(
						dir,
						"docs",
						"development",
						"runs",
						"alpha",
						"run_human",
						"decisions.jsonl",
					),
					"utf-8",
				);
				const lines = decodeJsonlFile(decisions, "run_human");
				expect(
					lines.some((l) => l.idempotencyKey.includes("decision:human")),
				).toBe(true);
				expect(
					lines.some((l) => l.idempotencyKey === "decision:prompt:prompt_1"),
				).toBe(true);
				for (const line of lines) {
					expect(line.origin).toBeNull();
					expect(line.materializer?.performer.role).toBe("exporter");
				}
			} finally {
				db.close();
			}
		});
	});
});
