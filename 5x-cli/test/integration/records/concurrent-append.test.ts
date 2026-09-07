/**
 * Two OS processes concurrently atomicAppend distinct ops to one run.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkingTreeRecordStore } from "../../../src/control-plane/record-fs.js";
import {
	RECORD_LINE_SCHEMA_VERSION,
	type RecordOrigin,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import { planSlugFromPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const FIXED_NOW = "2026-09-03 12:00:00";
const PLAN_PATH = "docs/development/plans/sample-plan.md";
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "550e8400-e29b-41d4-a716-446655440000" },
	performer: { kind: "system", role: "cli" },
};

const RECORD_FS = join(
	import.meta.dir,
	"../../../src/control-plane/record-fs.ts",
);

function leftoverTxn(runDir: string): string[] {
	if (!existsSync(runDir)) return [];
	return readdirSync(runDir).filter((name) => name.startsWith(".txn"));
}

async function spawnWorker(
	script: string,
	timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "-e", script], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: cleanGitEnv(),
	});
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout, stderr, exitCode };
}

describe("concurrent atomicAppend", () => {
	test(
		"two processes append distinct step vs budget ops; both persist; no leftover txn",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "5x-rec-conc-"));
			try {
				const store = createWorkingTreeRecordStore({
					recordsRoot: root,
					now: () => FIXED_NOW,
					fsyncFile: () => {},
					fsyncDir: () => {},
					onWarn: () => {},
				});
				store.putRun({
					id: "run_1",
					plan_path: PLAN_PATH,
					config_json: null,
					created_at: FIXED_NOW,
					sealed_at: null,
					status: "active",
					final_head_commit: null,
					cli_version: "1.3.0",
					format_version: 1,
					creator: { installation_id: ORIGIN.recorder.installation_id },
				});
				const stepKey = stepIdempotencyKey({
					runId: "run_1",
					stepName: "git:commit",
					phase: null,
					iteration: 1,
				});
				const stepOp = {
					runId: "run_1",
					stream: "steps",
					idempotencyKey: stepKey,
					payload: { step_name: "git:commit" },
					...recordedEnvelope(ORIGIN),
					schemaVersion: RECORD_LINE_SCHEMA_VERSION,
				};
				const budgetOp = {
					runId: "run_1",
					stream: "budget",
					idempotencyKey: "budget:concurrent",
					payload: { n: 1 },
					...recordedEnvelope(ORIGIN),
					schemaVersion: RECORD_LINE_SCHEMA_VERSION,
				};
				const worker = (op: unknown, goFile: string) => `
					import { createWorkingTreeRecordStore } from ${JSON.stringify(RECORD_FS)};
					import { existsSync } from "node:fs";
					const go = ${JSON.stringify(goFile)};
					const store = createWorkingTreeRecordStore({
						recordsRoot: ${JSON.stringify(root)},
						now: () => ${JSON.stringify(FIXED_NOW)},
						fsyncFile: () => {},
						fsyncDir: () => {},
						onWarn: () => {},
					});
					while (!existsSync(go)) {}
					store.atomicAppend([${JSON.stringify(op)}]);
					process.stdout.write("ok");
				`;
				const repeats = 8;
				for (let i = 0; i < repeats; i++) {
					const goFile = join(root, `go-${i}`);
					const a = spawnWorker(worker(stepOp, goFile));
					const b = spawnWorker(worker(budgetOp, goFile));
					await Bun.sleep(20);
					await Bun.write(goFile, "1");
					const [ra, rb] = await Promise.all([a, b]);
					expect(ra.exitCode).toBe(0);
					expect(rb.exitCode).toBe(0);
					const reopened = createWorkingTreeRecordStore({
						recordsRoot: root,
						now: () => FIXED_NOW,
						fsyncFile: () => {},
						fsyncDir: () => {},
						onWarn: () => {},
					});
					expect(reopened.getLine("run_1", "steps", stepKey)?.payload).toEqual({
						step_name: "git:commit",
					});
					expect(
						reopened.getLine("run_1", "budget", "budget:concurrent")?.payload,
					).toEqual({ n: 1 });
					const runDir = join(root, planSlugFromPath(PLAN_PATH), "run_1");
					expect(leftoverTxn(runDir)).toEqual([]);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"contender paused against after-lock-temp-written does not recover or double-own",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "5x-rec-lockrace-"));
			try {
				const store = createWorkingTreeRecordStore({
					recordsRoot: root,
					now: () => FIXED_NOW,
					fsyncFile: () => {},
					fsyncDir: () => {},
					onWarn: () => {},
				});
				store.putRun({
					id: "run_1",
					plan_path: PLAN_PATH,
					config_json: null,
					created_at: FIXED_NOW,
					sealed_at: null,
					status: "active",
					final_head_commit: null,
					cli_version: "1.3.0",
					format_version: 1,
					creator: { installation_id: ORIGIN.recorder.installation_id },
				});
				const paused = join(root, "paused");
				const resume = join(root, "resume");
				const stepKey = stepIdempotencyKey({
					runId: "run_1",
					stepName: "a",
					phase: null,
					iteration: 1,
				});
				const workerA = `
					import { createWorkingTreeRecordStore } from ${JSON.stringify(RECORD_FS)};
					import { existsSync, writeFileSync } from "node:fs";
					const store = createWorkingTreeRecordStore({
						recordsRoot: ${JSON.stringify(root)},
						now: () => ${JSON.stringify(FIXED_NOW)},
						fsyncFile: () => {},
						fsyncDir: () => {},
						onWarn: () => {},
						onTxnEvent: (e) => {
							if (e === "after-lock-temp-written") {
								writeFileSync(${JSON.stringify(paused)}, "1");
								while (!existsSync(${JSON.stringify(resume)})) {}
							}
						},
					});
					store.append({
						runId: "run_1",
						stream: "steps",
						idempotencyKey: ${JSON.stringify(stepKey)},
						payload: { who: "a" },
						schemaVersion: 1,
						provenance: "recorded",
						origin: ${JSON.stringify(ORIGIN)},
					});
				`;
				const workerB = `
					import { createWorkingTreeRecordStore } from ${JSON.stringify(RECORD_FS)};
					import { RecordStoreError } from ${JSON.stringify(join(import.meta.dir, "../../../src/control-plane/record-types.ts"))};
					const store = createWorkingTreeRecordStore({
						recordsRoot: ${JSON.stringify(root)},
						now: () => ${JSON.stringify(FIXED_NOW)},
						fsyncFile: () => {},
						fsyncDir: () => {},
						onWarn: () => {},
						lockTimeoutMs: 150,
						lockPollMs: 20,
					});
					try {
						store.append({
							runId: "run_1",
							stream: "budget",
							idempotencyKey: "budget:b",
							payload: { who: "b" },
							schemaVersion: 1,
							provenance: "recorded",
							origin: ${JSON.stringify(ORIGIN)},
						});
						process.stdout.write("appended");
					} catch (err) {
						process.stdout.write(err instanceof RecordStoreError ? err.code : String(err));
					}
				`;
				const a = spawnWorker(workerA);
				const start = Date.now();
				while (!existsSync(paused) && Date.now() - start < 8000) {
					await Bun.sleep(15);
				}
				expect(existsSync(paused)).toBe(true);
				const runDir = join(root, planSlugFromPath(PLAN_PATH), "run_1");
				expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(false);
				const b = await spawnWorker(workerB);
				expect(b.exitCode).toBe(0);
				expect(
					b.stdout === "RECORD_TXN_LOCKED" || b.stdout === "appended",
				).toBe(true);
				if (b.stdout === "appended") {
					expect(existsSync(join(runDir, ".txn.journal.json"))).toBe(false);
				}
				await Bun.write(resume, "1");
				const ra = await a;
				expect(ra.exitCode).toBe(0);
				const reopened = createWorkingTreeRecordStore({
					recordsRoot: root,
					now: () => FIXED_NOW,
					fsyncFile: () => {},
					fsyncDir: () => {},
					onWarn: () => {},
				});
				expect(reopened.getLine("run_1", "steps", stepKey)?.payload).toEqual({
					who: "a",
				});
				expect(leftoverTxn(runDir)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
