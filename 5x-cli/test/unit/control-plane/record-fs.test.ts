import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWorkingTreeRecordStore,
	resetWorkingTreeLockOwnersForTest,
	type TxnEvent,
} from "../../../src/control-plane/record-fs.js";
import { runRecordDir } from "../../../src/control-plane/record-layout.js";
import type { RecordStore } from "../../../src/control-plane/record-store.js";
import {
	type RecordOrigin,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import { planSlugFromPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const FIXED_NOW = "2026-09-03 12:00:00";
const INSTALLATION_ID = randomUUID();
const DEAD_PID = 1_000_000_007;
const PLAN_PATH = "docs/development/plans/sample-plan.md";
const SLUG = planSlugFromPath(PLAN_PATH);

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: INSTALLATION_ID, actor: "test-operator" },
	performer: { kind: "agent", role: "reviewer", provider: "opencode" },
};

const dirs: string[] = [];

function makeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "5x-rec-fs-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	resetWorkingTreeLockOwnersForTest();
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function v1Summary(
	id: string,
	overrides: Partial<RunRecordSummary> = {},
): RunRecordSummary {
	return {
		id,
		plan_path: PLAN_PATH,
		config_json: null,
		created_at: FIXED_NOW,
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: { installation_id: INSTALLATION_ID, actor: "test-operator" },
		...overrides,
	};
}

function stepPayload(name: string) {
	return {
		step_name: name,
		phase: null,
		iteration: 1,
		result_json: { ok: true },
		head_commit: "abc123",
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`expected RecordStoreError ${code}`);
	} catch (err) {
		expect(err).toBeInstanceOf(RecordStoreError);
		expect((err as RecordStoreError).code).toBe(code);
	}
}

function storeFor(
	root: string,
	extra: {
		onTxnEvent?: (event: TxnEvent) => void;
		fsyncDir?: (dir: string) => void;
		lockTimeoutMs?: number;
		lockPollMs?: number;
	} = {},
): RecordStore {
	return createWorkingTreeRecordStore({
		recordsRoot: root,
		now: () => FIXED_NOW,
		fsyncFile: () => {},
		fsyncDir: extra.fsyncDir ?? (() => {}),
		onWarn: () => {},
		onTxnEvent: extra.onTxnEvent,
		lockTimeoutMs: extra.lockTimeoutMs,
		lockPollMs: extra.lockPollMs,
	});
}

function runDir(root: string, runId: string): string {
	return runRecordDir(root, SLUG, runId);
}

function plantDeadLock(dir: string): void {
	const lock = join(dir, ".txn.lock");
	if (!existsSync(lock)) return;
	const doc = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
	writeFileSync(lock, `${JSON.stringify({ ...doc, pid: DEAD_PID })}\n`);
}

function reopen(root: string, dir: string): RecordStore {
	resetWorkingTreeLockOwnersForTest();
	plantDeadLock(dir);
	return storeFor(root);
}

function mixedOps(runId: string) {
	const stepKey = stepIdempotencyKey({
		runId,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
	});
	return {
		stepKey,
		ops: [
			{
				runId,
				stream: "steps" as const,
				idempotencyKey: stepKey,
				payload: stepPayload("reviewer:plan"),
				...recordedEnvelope(ORIGIN),
			},
			{
				runId,
				stream: "budget" as const,
				idempotencyKey: "budget:snapshot:reviewer:plan:1",
				payload: { remaining: 3 },
				...recordedEnvelope(ORIGIN),
			},
		],
	};
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("working-tree layout and putRun", () => {
	test("putRun creates nested dirs; append writes one JSONL line; listLines returns runId", () => {
		const root = makeRoot();
		const fsynced: string[] = [];
		const store = storeFor(root, { fsyncDir: (d) => fsynced.push(d) });
		store.putRun(v1Summary("run_1"));
		const dir = runDir(root, "run_1");
		expect(existsSync(join(dir, "run.json"))).toBe(true);
		expect(
			JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).format_version,
		).toBe(1);
		expect(
			JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).creator,
		).toEqual({
			installation_id: INSTALLATION_ID,
			actor: "test-operator",
		});
		expect(fsynced.some((d) => d === dir || d.startsWith(root))).toBe(true);

		const key = stepIdempotencyKey({
			runId: "run_1",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: key,
			payload: stepPayload("x"),
			...recordedEnvelope(ORIGIN),
		});
		const stepsPath = join(dir, "steps.jsonl");
		const text = readFileSync(stepsPath, "utf8");
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
		expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("run_id");
		const loaded = store.listLines("run_1", "steps");
		expect(loaded[0]?.runId).toBe("run_1");
		expect(store.getLine("run_1", "steps", key)?.runId).toBe("run_1");
	});

	test("union-concatenated file with two keys returns both in file order with each origin; duplicate key first wins", () => {
		const root = makeRoot();
		const store = storeFor(root);
		store.putRun(v1Summary("run_1"));
		const other: RecordOrigin = {
			recorder: { installation_id: randomUUID(), actor: "b" },
			performer: { kind: "human", role: "operator" },
		};
		const a = {
			schema_version: 1,
			stream: "steps",
			idempotency_key: "step:a",
			created_at: FIXED_NOW,
			provenance: "recorded",
			origin: ORIGIN,
			payload: { n: 1 },
		};
		const b = {
			schema_version: 1,
			stream: "steps",
			idempotency_key: "step:b",
			created_at: FIXED_NOW,
			provenance: "recorded",
			origin: other,
			payload: { n: 2 },
		};
		const dup = {
			...a,
			payload: { n: 99 },
			origin: other,
		};
		writeFileSync(
			join(runDir(root, "run_1"), "steps.jsonl"),
			`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`,
		);
		const both = store.listLines("run_1", "steps");
		expect(both.map((l) => l.idempotencyKey)).toEqual(["step:a", "step:b"]);
		expect(both[0]?.origin).toEqual(ORIGIN);
		expect(both[1]?.origin).toEqual(other);

		writeFileSync(
			join(runDir(root, "run_1"), "steps.jsonl"),
			`${JSON.stringify(a)}\n${JSON.stringify(dup)}\n`,
		);
		const first = store.listLines("run_1", "steps");
		expect(first).toHaveLength(1);
		expect(first[0]?.payload).toEqual({ n: 1 });
		expect(first[0]?.origin).toEqual(ORIGIN);
	});

	test("planted format_version 2 + future_field is readable; putRun refuses and leaves bytes", () => {
		const root = makeRoot();
		const store = storeFor(root);
		store.putRun(v1Summary("run_v2"));
		const path = join(runDir(root, "run_v2"), "run.json");
		const planted = {
			...JSON.parse(readFileSync(path, "utf8")),
			format_version: 2,
			future_field: true,
		};
		const bytes = `${JSON.stringify(planted, null, 2)}\n`;
		writeFileSync(path, bytes);
		expect(store.getRun("run_v2")?.format_version).toBe(2);
		expectCode(
			() => store.putRun(v1Summary("run_v2", { status: "completed" })),
			"UNSUPPORTED_FORMAT_VERSION",
		);
		expect(readFileSync(path, "utf8")).toContain("future_field");
		expect(readFileSync(path, "utf8")).toContain('"format_version": 2');
	});

	test("putRun of creator null is persisted; getRun does not promote materializer", () => {
		const root = makeRoot();
		const store = storeFor(root);
		const exporter: RecordOrigin = {
			recorder: { installation_id: INSTALLATION_ID },
			performer: { kind: "system", role: "exporter" },
		};
		store.putRun(
			v1Summary("run_bf", {
				creator: null,
				materializer: exporter,
				backfilled: true,
			}),
		);
		const loaded = store.getRun("run_bf");
		expect(loaded?.creator).toBeNull();
		expect(loaded?.materializer).toEqual(exporter);
		expect(loaded?.sealer).toBeUndefined();
	});
});

describe("atomicAppend crash recovery", () => {
	const rollbackEvents: TxnEvent[] = [
		"after-new",
		"after-dirsync:staging",
		"after-dirsync:prepared",
	];

	for (const event of rollbackEvents) {
		test(`interrupt at ${event} rolls back mixed [step, budget]`, () => {
			const root = makeRoot();
			const store = storeFor(root, {
				onTxnEvent: (e) => {
					if (e === event) throw new Error(`crash:${event}`);
				},
			});
			store.putRun(v1Summary("run_1"));
			const { stepKey, ops } = mixedOps("run_1");
			expect(() => store.atomicAppend(ops)).toThrow(`crash:${event}`);
			const dir = runDir(root, "run_1");
			const reopened = reopen(root, dir);
			expect(reopened.getLine("run_1", "steps", stepKey)).toBeNull();
			expect(reopened.listLines("run_1", "budget")).toEqual([]);
			expect(existsSync(join(dir, ".txn.journal.json"))).toBe(false);
			expect(existsSync(join(dir, ".txn.commit"))).toBe(false);
		});
	}

	const forwardEvents: TxnEvent[] = [
		"after-dirsync:commit",
		"after-rename:steps",
		"after-dirsync:rename:steps",
	];

	for (const event of forwardEvents) {
		test(`interrupt at ${event} rolls forward mixed batch`, () => {
			const root = makeRoot();
			const store = storeFor(root, {
				onTxnEvent: (e) => {
					if (e === event) throw new Error(`crash:${event}`);
				},
			});
			store.putRun(v1Summary("run_1"));
			const { stepKey, ops } = mixedOps("run_1");
			expect(() => store.atomicAppend(ops)).toThrow(`crash:${event}`);
			const dir = runDir(root, "run_1");
			const reopened = reopen(root, dir);
			expect(reopened.getLine("run_1", "steps", stepKey)?.payload).toEqual(
				stepPayload("reviewer:plan"),
			);
			expect(
				reopened.getLine("run_1", "budget", "budget:snapshot:reviewer:plan:1")
					?.payload,
			).toEqual({ remaining: 3 });
			expect(existsSync(join(dir, ".txn.journal.json"))).toBe(false);
			expect(existsSync(join(dir, ".txn.commit"))).toBe(false);
		});
	}

	test("interrupt during recovery of a committed txn; second open finishes", () => {
		const root = makeRoot();
		let recoveries = 0;
		const crashing = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "after-dirsync:commit") throw new Error("crash:commit");
			},
		});
		crashing.putRun(v1Summary("run_1"));
		const { stepKey, ops } = mixedOps("run_1");
		expect(() => crashing.atomicAppend(ops)).toThrow("crash:commit");
		const dir = runDir(root, "run_1");
		resetWorkingTreeLockOwnersForTest();
		plantDeadLock(dir);
		const firstOpen = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "during-recovery") recoveries += 1;
				if (e === "after-rename:steps" && recoveries === 1) {
					throw new Error("crash:recovery-rename");
				}
			},
		});
		expect(() => firstOpen.getLine("run_1", "steps", stepKey)).toThrow(
			"crash:recovery-rename",
		);
		const second = reopen(root, dir);
		expect(second.getLine("run_1", "steps", stepKey)).not.toBeNull();
		expect(
			second.getLine("run_1", "budget", "budget:snapshot:reviewer:plan:1"),
		).not.toBeNull();
	});

	test("fsyncDir throw after staging / prepared / commit / rename / cleanup is all-or-nothing or CORRUPT", () => {
		const points: TxnEvent[] = [
			"after-dirsync:staging",
			"after-dirsync:prepared",
			"after-dirsync:commit",
			"after-dirsync:rename:steps",
		];
		for (const point of points) {
			const root = makeRoot();
			let armed = false;
			const store = storeFor(root, {
				onTxnEvent: (e) => {
					if (e === point) armed = true;
				},
				fsyncDir: () => {
					if (armed) throw new Error(`fsyncDir after ${point}`);
				},
			});
			store.putRun(v1Summary("run_1"));
			armed = false;
			const { stepKey, ops } = mixedOps("run_1");
			expect(() => store.atomicAppend(ops)).toThrow(/fsyncDir/);
			const dir = runDir(root, "run_1");
			const reopened = reopen(root, dir);
			try {
				const step = reopened.getLine("run_1", "steps", stepKey);
				const budget = reopened.getLine(
					"run_1",
					"budget",
					"budget:snapshot:reviewer:plan:1",
				);
				expect(Boolean(step)).toBe(Boolean(budget));
			} catch (err) {
				expect(err).toBeInstanceOf(RecordStoreError);
				expect((err as RecordStoreError).code).toBe("RECORD_TXN_CORRUPT");
				expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
			}
		}
	});

	test("torn commit marker throws RECORD_TXN_CORRUPT and keeps artifacts", () => {
		const root = makeRoot();
		const store = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "after-dirsync:prepared")
					throw new Error("stop-before-commit");
			},
		});
		store.putRun(v1Summary("run_1"));
		const { stepKey, ops } = mixedOps("run_1");
		expect(() => store.atomicAppend(ops)).toThrow("stop-before-commit");
		const dir = runDir(root, "run_1");
		writeFileSync(join(dir, ".txn.commit"), "{");
		resetWorkingTreeLockOwnersForTest();
		plantDeadLock(dir);
		const reopened = storeFor(root);
		expectCode(
			() => reopened.getLine("run_1", "steps", stepKey),
			"RECORD_TXN_CORRUPT",
		);
		expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
		expect(existsSync(join(dir, ".txn.commit"))).toBe(true);
		expectCode(
			() => reopened.listLines("run_1", "budget"),
			"RECORD_TXN_CORRUPT",
		);
	});

	test("corrupt journal after commit throws RECORD_TXN_CORRUPT and does not delete staging", () => {
		const root = makeRoot();
		const store = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "after-rename:steps") throw new Error("stop-mid-rename");
			},
		});
		store.putRun(v1Summary("run_1"));
		const { ops } = mixedOps("run_1");
		expect(() => store.atomicAppend(ops)).toThrow("stop-mid-rename");
		const dir = runDir(root, "run_1");
		writeFileSync(join(dir, ".txn.journal.json"), "not-json");
		resetWorkingTreeLockOwnersForTest();
		plantDeadLock(dir);
		expectCode(
			() => storeFor(root).listLines("run_1", "steps"),
			"RECORD_TXN_CORRUPT",
		);
		expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
		expect(existsSync(join(dir, ".txn.commit"))).toBe(true);
	});

	test("JS throw before commit rolls back in-process and releases the lock", () => {
		const root = makeRoot();
		const store = storeFor(root);
		store.putRun(v1Summary("run_1"));
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const stepKey = stepIdempotencyKey({
			runId: "run_1",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		expect(() =>
			store.atomicAppend([
				{
					runId: "run_1",
					stream: "steps",
					idempotencyKey: stepKey,
					payload: circular,
					...recordedEnvelope(ORIGIN),
				},
			]),
		).toThrow();
		expect(store.getLine("run_1", "steps", stepKey)).toBeNull();
		const dir = runDir(root, "run_1");
		expect(existsSync(join(dir, ".txn.lock"))).toBe(false);
		expect(existsSync(join(dir, ".txn.journal.json"))).toBe(false);
		store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: stepKey,
			payload: stepPayload("x"),
			...recordedEnvelope(ORIGIN),
		});
		expect(store.getLine("run_1", "steps", stepKey)).not.toBeNull();
	});
});

describe("per-run writer lock", () => {
	test("stale lock is stolen then a subsequent append succeeds", () => {
		const root = makeRoot();
		const store = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "after-dirsync:prepared") throw new Error("crash-prepared");
			},
		});
		store.putRun(v1Summary("run_1"));
		const { stepKey, ops } = mixedOps("run_1");
		expect(() => store.atomicAppend(ops)).toThrow("crash-prepared");
		const dir = runDir(root, "run_1");
		const reopened = reopen(root, dir);
		expect(reopened.getLine("run_1", "steps", stepKey)).toBeNull();
		reopened.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: stepKey,
			payload: stepPayload("reviewer:plan"),
			...recordedEnvelope(ORIGIN),
		});
		expect(reopened.getLine("run_1", "steps", stepKey)).not.toBeNull();
	});

	test("lock pathname is never empty after after-lock-linked / after-lock-acquired", () => {
		const root = makeRoot();
		const seen: string[] = [];
		const store = storeFor(root, {
			onTxnEvent: (e) => {
				if (e === "after-lock-linked" || e === "after-lock-acquired") {
					const text = readFileSync(
						join(runDir(root, "run_1"), ".txn.lock"),
						"utf8",
					);
					seen.push(e);
					const doc = JSON.parse(text) as {
						version: number;
						pid: number;
						owner: string;
					};
					expect(doc.version).toBe(1);
					expect(doc.pid).toBe(process.pid);
					expect(typeof doc.owner).toBe("string");
					expect(doc.owner.length).toBeGreaterThan(0);
					expect(text.trim().length).toBeGreaterThan(0);
				}
			},
		});
		store.putRun(v1Summary("run_1"));
		expect(seen).toContain("after-lock-linked");
		expect(seen).toContain("after-lock-acquired");
	});

	test("malformed lock is not immediately stolen", () => {
		const root = makeRoot();
		const store = storeFor(root);
		store.putRun(v1Summary("run_1"));
		const dir = runDir(root, "run_1");
		const lock = join(dir, ".txn.lock");
		writeFileSync(lock, "");
		let sawEmptyWhileWaiting = 0;
		const waiter = storeFor(root, {
			lockTimeoutMs: 80,
			lockPollMs: 20,
			onTxnEvent: (e) => {
				if (e === "after-lock-temp-written" && existsSync(lock)) {
					const text = readFileSync(lock, "utf8");
					if (text === "") sawEmptyWhileWaiting += 1;
				}
			},
		});
		waiter.getRun("run_1");
		expect(sawEmptyWhileWaiting).toBeGreaterThanOrEqual(2);
		expect(waiter.getRun("run_1")?.id).toBe("run_1");
	});

	test("live lock is not recovered (child holds prepared txn)", () => {
		const root = makeRoot();
		storeFor(root).putRun(v1Summary("run_1"));
		const dir = runDir(root, "run_1");
		const ready = join(root, "ready");
		const done = join(root, "done");
		const recordFs = join(
			import.meta.dir,
			"../../../src/control-plane/record-fs.ts",
		);
		const { stepKey, ops } = mixedOps("run_1");
		const script = `
			import { createWorkingTreeRecordStore } from ${JSON.stringify(recordFs)};
			import { writeFileSync, existsSync } from "node:fs";
			const store = createWorkingTreeRecordStore({
				recordsRoot: ${JSON.stringify(root)},
				now: () => ${JSON.stringify(FIXED_NOW)},
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
				onTxnEvent: (e) => {
					if (e === "after-dirsync:prepared") {
						writeFileSync(${JSON.stringify(ready)}, "1");
						while (!existsSync(${JSON.stringify(done)})) {}
					}
				},
			});
			store.atomicAppend(${JSON.stringify(ops)});
		`;
		const child = Bun.spawn(["bun", "-e", script], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: cleanGitEnv(),
		});
		const started = Date.now();
		while (!existsSync(ready) && Date.now() - started < 8000) {
			Bun.sleepSync(20);
		}
		expect(existsSync(ready)).toBe(true);
		expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
		const contender = storeFor(root, {
			lockTimeoutMs: 80,
			lockPollMs: 15,
		});
		expectCode(
			() => contender.getLine("run_1", "steps", stepKey),
			"RECORD_TXN_LOCKED",
		);
		expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
		writeFileSync(done, "1");
		const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
		return Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]).then(([, stderr, code]) => {
			clearTimeout(timer);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			const after = storeFor(root);
			expect(after.getLine("run_1", "steps", stepKey)).not.toBeNull();
		});
	}, 15000);

	test("after-lock-linked is already a complete live-PID record; contender does not steal", () => {
		const root = makeRoot();
		storeFor(root).putRun(v1Summary("run_1"));
		const dir = runDir(root, "run_1");
		const ready = join(root, "linked");
		const done = join(root, "done-linked");
		const recordFs = join(
			import.meta.dir,
			"../../../src/control-plane/record-fs.ts",
		);
		const script = `
			import { createWorkingTreeRecordStore } from ${JSON.stringify(recordFs)};
			import { writeFileSync, existsSync } from "node:fs";
			const store = createWorkingTreeRecordStore({
				recordsRoot: ${JSON.stringify(root)},
				now: () => ${JSON.stringify(FIXED_NOW)},
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
				onTxnEvent: (e) => {
					if (e === "after-lock-linked") {
						writeFileSync(${JSON.stringify(ready)}, "1");
						while (!existsSync(${JSON.stringify(done)})) {}
					}
				},
			});
			store.getRun("run_1");
		`;
		const child = Bun.spawn(["bun", "-e", script], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: cleanGitEnv(),
		});
		const started = Date.now();
		while (!existsSync(ready) && Date.now() - started < 8000) {
			Bun.sleepSync(20);
		}
		expect(existsSync(ready)).toBe(true);
		const lockText = readFileSync(join(dir, ".txn.lock"), "utf8");
		const doc = JSON.parse(lockText) as {
			version: number;
			pid: number;
			owner: string;
		};
		expect(doc.version).toBe(1);
		expect(doc.pid).toBeGreaterThan(0);
		expect(doc.owner.length).toBeGreaterThan(0);
		const contender = storeFor(root, { lockTimeoutMs: 80, lockPollMs: 15 });
		expectCode(() => contender.getRun("run_1"), "RECORD_TXN_LOCKED");
		expect(existsSync(join(dir, ".txn.lock"))).toBe(true);
		writeFileSync(done, "1");
		const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
		return Promise.all([child.exited]).then(([code]) => {
			clearTimeout(timer);
			expect(code).toBe(0);
		});
	}, 15000);

	test("creation-window: empty wx lock is not stolen on first observation", () => {
		const root = makeRoot();
		storeFor(root).putRun(v1Summary("run_1"));
		const dir = runDir(root, "run_1");
		const lock = join(dir, ".txn.lock");
		const journal = join(dir, ".txn.journal.json");
		writeFileSync(
			journal,
			`${JSON.stringify({
				version: 1,
				streams: ["steps"],
				created: { steps: true },
				new_sha256: { steps: sha256("") },
				old_sha256: {},
			})}\n`,
		);
		const holder = Bun.spawn(
			[
				"bun",
				"-e",
				`import { openSync } from "node:fs"; openSync(${JSON.stringify(lock)}, "wx"); while (true) {}`,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: cleanGitEnv(),
			},
		);
		const started = Date.now();
		while (!existsSync(lock) && Date.now() - started < 5000) {
			Bun.sleepSync(10);
		}
		expect(existsSync(lock)).toBe(true);
		let sawJournalDuringWait = 0;
		const contender = storeFor(root, {
			lockTimeoutMs: 5000,
			lockPollMs: 25,
			onTxnEvent: (e) => {
				if (e === "after-lock-temp-written") {
					if (existsSync(journal) && existsSync(lock)) {
						sawJournalDuringWait += 1;
					}
					if (sawJournalDuringWait >= 2) {
						throw new Error("stop-before-steal");
					}
				}
			},
		});
		expect(() => contender.getRun("run_1")).toThrow("stop-before-steal");
		expect(sawJournalDuringWait).toBeGreaterThanOrEqual(2);
		expect(existsSync(journal)).toBe(true);
		expect(existsSync(lock)).toBe(true);
		holder.kill("SIGKILL");
		return holder.exited;
	}, 15000);
});
