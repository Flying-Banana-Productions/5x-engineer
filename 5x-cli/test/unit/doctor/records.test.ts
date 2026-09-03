/**
 * Unit tests for the doctor records check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	encodeJsonlFile,
	encodeRunJson,
} from "../../../src/control-plane/record-layout.js";
import {
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/schema.js";
import {
	createRecordsCheck,
	recordsCheck,
} from "../../../src/doctor/checks/records.js";
import { LINGERING_RUN_AGE_MS } from "../../../src/doctor/checks/runs.js";
import { findingKey } from "../../../src/doctor/registry.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../../../src/doctor/types.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const dirs: string[] = [];
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: INSTALLATION_ID },
	performer: { kind: "system", role: "cli" },
};
const DEAD_PID = 1_000_000_007;

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-records-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	closeDb();
	_resetForTest();
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

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

function doctorCtx(projectRoot: string, now?: number): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
		now,
	};
}

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

function seedDb(dir: string): void {
	const db = getDb(dir);
	runMigrations(db);
	closeDb();
	_resetForTest();
}

function v1Summary(id: string): RunRecordSummary {
	return {
		id,
		plan_path: "docs/development/alpha.md",
		config_json: null,
		created_at: "2026-09-01 12:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: { installation_id: INSTALLATION_ID },
	};
}

function stepLine(
	runId: string,
	name: string,
	head?: string | null,
): RecordLine {
	const phase = "1";
	const iteration = 1;
	return {
		runId,
		stream: "steps",
		idempotencyKey: stepIdempotencyKey({
			runId,
			stepName: name,
			phase,
			iteration,
		}),
		payload: {
			step_name: name,
			phase,
			iteration,
			result_json: { ok: true },
			head_commit: head === undefined ? "abc123" : head,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		createdAt: "2026-09-01 12:00:00",
		schemaVersion: RECORD_LINE_SCHEMA_VERSION,
		provenance: "recorded",
		origin: ORIGIN,
	};
}

function writeCommittedRecords(
	dir: string,
	summary: RunRecordSummary,
	steps: RecordLine[],
): string {
	const runDir = join(dir, "docs", "development", "runs", "alpha", summary.id);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "run.json"), encodeRunJson(summary));
	writeFileSync(join(runDir, "steps.jsonl"), encodeJsonlFile(steps));
	mkdirSync(join(dir, "docs", "development"), { recursive: true });
	writeFileSync(
		join(dir, "docs", "development", "alpha.md"),
		"# Alpha\n\n## Phase 1: P1\n\n- [x] task\n",
	);
	git(["add", "-A"], dir);
	git(["commit", "-m", "records"], dir);
	return runDir;
}

describe("doctor records check", () => {
	test("healthy project reports RECORD_INDEX_OK", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const findings = await recordsCheck.run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_INDEX_OK")).toBe(true);
		expect(findings.every((f) => f.status !== "fail")).toBe(true);
	});

	test("missing run and missing row are fixable; --fix re-indexes once", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		const check = createRecordsCheck();
		const detected = await check.run(doctorCtx(dir));
		expect(detected.some((f) => f.code === "RECORD_INDEX_MISSING_RUN")).toBe(
			true,
		);
		expect(detected.some((f) => f.code === "RECORD_INDEX_MISSING_ROW")).toBe(
			true,
		);
		const missingRun = detected.find(
			(f) => f.code === "RECORD_INDEX_MISSING_RUN",
		);
		expect(missingRun).toBeDefined();
		if (!missingRun) throw new Error("expected MISSING_RUN");
		expect(findingKey(missingRun)).toContain("run_alpha");
		const missingRow = detected.find(
			(f) => f.code === "RECORD_INDEX_MISSING_ROW",
		);
		expect(missingRow).toBeDefined();
		if (!missingRow) throw new Error("expected MISSING_ROW");
		expect(findingKey(missingRow)).toContain("step:");

		const fixRun = await applyFix(check, missingRun, doctorCtx(dir));
		expect(fixRun.attempted).toBe(true);
		const fixRow = await applyFix(check, missingRow, doctorCtx(dir));
		expect(fixRow.attempted).toBe(false);

		const again = await check.run(doctorCtx(dir));
		expect(again.some((f) => f.code === "RECORD_INDEX_MISSING_RUN")).toBe(
			false,
		);
		expect(again.some((f) => f.code === "RECORD_INDEX_MISSING_ROW")).toBe(
			false,
		);
	});

	test("extra sqlite step is RECORD_INDEX_EXTRA_ROW (not fixable)", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		const check = createRecordsCheck();
		await applyFix(
			check,
			{
				check: "records",
				status: "fail",
				code: "RECORD_INDEX_MISSING_RUN",
				message: "index",
				fixable: true,
				detail: { runId: "run_alpha", planSlug: "alpha" },
			},
			doctorCtx(dir),
		);
		const db = getDb(dir);
		db.query(
			`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
			 VALUES (?1, ?2, ?3, ?4, ?5)`,
		).run("run_alpha", "local:only", "1", 1, "{}");
		closeDb();
		_resetForTest();

		const findings = await createRecordsCheck().run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_INDEX_EXTRA_ROW")).toBe(
			true,
		);
		expect(
			findings.find((f) => f.code === "RECORD_INDEX_EXTRA_ROW")?.fixable,
		).toBe(false);
	});

	test("unreachable head_commit is a warn", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine(
				"run_alpha",
				"author:impl",
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			),
		]);
		const findings = await createRecordsCheck().run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_HEAD_UNREACHABLE")).toBe(
			true,
		);
		expect(
			findings.find((f) => f.code === "RECORD_HEAD_UNREACHABLE")?.status,
		).toBe("warn");
	});

	test("stale uncommitted record files warn RECORD_UNCOMMITTED_STALE", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const stalePath = join(
			dir,
			"docs",
			"development",
			"runs",
			"alpha",
			"run_stale",
			"run.json",
		);
		mkdirSync(resolve(stalePath, ".."), { recursive: true });
		writeFileSync(stalePath, "{}\n");
		const past = (Date.now() - LINGERING_RUN_AGE_MS - 60_000) / 1000;
		utimesSync(stalePath, past, past);

		const findings = await createRecordsCheck().run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_UNCOMMITTED_STALE")).toBe(
			true,
		);
	});

	test("torn .txn.commit reports RECORD_TXN_CORRUPT; --fix does not delete it", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const runDir = writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		writeFileSync(join(runDir, ".txn.journal.json"), "{not-json");
		writeFileSync(join(runDir, ".txn.commit"), "{");
		const check = createRecordsCheck();
		const findings = await check.run(doctorCtx(dir));
		const corrupt = findings.find((f) => f.code === "RECORD_TXN_CORRUPT");
		expect(corrupt).toBeDefined();
		expect(corrupt?.fixable).toBe(false);
		expect(corrupt?.status).toBe("fail");
		const detail =
			corrupt?.detail && typeof corrupt.detail === "object"
				? (corrupt.detail as { runId?: string })
				: {};
		expect(detail.runId).toBe("run_alpha");

		const result = await applyFix(check, corrupt, doctorCtx(dir));
		expect(result.attempted).toBe(false);
		expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(true);
		expect(existsSync(join(runDir, ".txn.commit"))).toBe(true);
	});

	test("live .txn.lock is not reported as corrupt and staging is kept", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const runDir = writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		const child = Bun.spawn(["sleep", "60"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		try {
			writeFileSync(
				join(runDir, ".txn.lock"),
				`${JSON.stringify({
					version: 1,
					pid: child.pid,
					owner: "live-owner",
					started_at: new Date().toISOString(),
				})}\n`,
			);
			writeFileSync(join(runDir, ".txn.journal.json"), "{}\n");
			writeFileSync(join(runDir, ".txn.steps.new"), "x");
			const findings = await createRecordsCheck().run(doctorCtx(dir));
			expect(findings.some((f) => f.code === "RECORD_TXN_CORRUPT")).toBe(false);
			expect(existsSync(join(runDir, ".txn.steps.new"))).toBe(true);
			expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	});

	test("empty .txn.lock plus journal is not immediately stolen or reported corrupt", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const runDir = writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		writeFileSync(join(runDir, ".txn.lock"), "");
		writeFileSync(join(runDir, ".txn.journal.json"), "{not-valid");
		writeFileSync(join(runDir, ".txn.commit"), "{");
		const findings = await createRecordsCheck().run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_TXN_CORRUPT")).toBe(false);
		expect(existsSync(join(runDir, ".txn.lock"))).toBe(true);
		expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(true);
		expect(existsSync(join(runDir, ".txn.commit"))).toBe(true);
	});

	test("unreadable .txn.lock is treated like malformed (not stolen)", async () => {
		const dir = makeTmp();
		initRepo(dir);
		seedDb(dir);
		const runDir = writeCommittedRecords(dir, v1Summary("run_alpha"), [
			stepLine("run_alpha", "author:impl"),
		]);
		writeFileSync(
			join(runDir, ".txn.lock"),
			`${JSON.stringify({ version: 1, pid: DEAD_PID })}\n`,
		);
		writeFileSync(join(runDir, ".txn.journal.json"), "{");
		const findings = await createRecordsCheck().run(doctorCtx(dir));
		expect(findings.some((f) => f.code === "RECORD_TXN_CORRUPT")).toBe(false);
		expect(existsSync(join(runDir, ".txn.lock"))).toBe(true);
	});
});
