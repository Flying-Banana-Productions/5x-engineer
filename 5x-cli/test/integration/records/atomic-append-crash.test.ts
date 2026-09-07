/**
 * Fault-injection for mixed-stream atomicAppend (working-tree journal).
 */

import { describe, expect, test } from "bun:test";
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
import {
	type RecordOrigin,
	RecordStoreError,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import { planSlugFromPath } from "../../../src/paths.js";

const FIXED_NOW = "2026-09-03 12:00:00";
const PLAN_PATH = "docs/development/plans/sample-plan.md";
const SLUG = planSlugFromPath(PLAN_PATH);
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "550e8400-e29b-41d4-a716-446655440000" },
	performer: { kind: "agent", role: "reviewer" },
};
const DEAD_PID = 1_000_000_007;

function plantDeadLock(dir: string): void {
	const lock = join(dir, ".txn.lock");
	if (!existsSync(lock)) return;
	const doc = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
	writeFileSync(lock, `${JSON.stringify({ ...doc, pid: DEAD_PID })}\n`);
}

describe("atomic-append crash (integration)", () => {
	test("interrupt after commit then reopen is all-or-nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "5x-rec-crash-"));
		try {
			const store = createWorkingTreeRecordStore({
				recordsRoot: root,
				now: () => FIXED_NOW,
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
				onTxnEvent: (e: TxnEvent) => {
					if (e === "after-rename:steps") throw new Error("crash-rename");
				},
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
				stepName: "reviewer:plan",
				phase: "plan",
				iteration: 1,
			});
			expect(() =>
				store.atomicAppend([
					{
						runId: "run_1",
						stream: "steps",
						idempotencyKey: stepKey,
						payload: { step_name: "reviewer:plan" },
						...recordedEnvelope(ORIGIN),
					},
					{
						runId: "run_1",
						stream: "budget",
						idempotencyKey: "budget:x",
						payload: { remaining: 1 },
						...recordedEnvelope(ORIGIN),
					},
				]),
			).toThrow("crash-rename");
			const dir = runRecordDir(root, SLUG, "run_1");
			resetWorkingTreeLockOwnersForTest();
			plantDeadLock(dir);
			const reopened = createWorkingTreeRecordStore({
				recordsRoot: root,
				now: () => FIXED_NOW,
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
			});
			expect(reopened.getLine("run_1", "steps", stepKey)).not.toBeNull();
			expect(reopened.getLine("run_1", "budget", "budget:x")).not.toBeNull();
			expect(existsSync(join(dir, ".txn.journal.json"))).toBe(false);
		} finally {
			resetWorkingTreeLockOwnersForTest();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("torn commit marker fails closed", () => {
		const root = mkdtempSync(join(tmpdir(), "5x-rec-corrupt-"));
		try {
			const store = createWorkingTreeRecordStore({
				recordsRoot: root,
				now: () => FIXED_NOW,
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
				onTxnEvent: (e: TxnEvent) => {
					if (e === "after-dirsync:prepared") throw new Error("stop");
				},
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
			expect(() =>
				store.append({
					runId: "run_1",
					stream: "steps",
					idempotencyKey: "k",
					payload: {},
					...recordedEnvelope(ORIGIN),
				}),
			).toThrow("stop");
			const dir = runRecordDir(root, SLUG, "run_1");
			writeFileSync(join(dir, ".txn.commit"), "garbage");
			resetWorkingTreeLockOwnersForTest();
			plantDeadLock(dir);
			const reopened = createWorkingTreeRecordStore({
				recordsRoot: root,
				now: () => FIXED_NOW,
				fsyncFile: () => {},
				fsyncDir: () => {},
				onWarn: () => {},
			});
			try {
				reopened.getLine("run_1", "steps", "k");
				throw new Error("expected RECORD_TXN_CORRUPT");
			} catch (err) {
				expect(err).toBeInstanceOf(RecordStoreError);
				expect((err as RecordStoreError).code).toBe("RECORD_TXN_CORRUPT");
			}
			expect(existsSync(join(dir, ".txn.journal.json"))).toBe(true);
			expect(existsSync(join(dir, ".txn.commit"))).toBe(true);
		} finally {
			resetWorkingTreeLockOwnersForTest();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
