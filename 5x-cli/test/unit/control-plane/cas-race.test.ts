/**
 * First-writer-wins CAS: parallel sqlite writers, and a TTY handler
 * racing an injected control-plane answer.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptChoose } from "../../../src/commands/prompt.handler.js";
import {
	createSqlitePromptStore,
	type PromptStore,
} from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";
import type { readLine } from "../../../src/utils/stdin.js";

async function invoke(fn: () => Promise<void>): Promise<{
	ok: boolean;
	error?: CliError;
}> {
	try {
		await fn();
		return { ok: true };
	} catch (err) {
		if (err instanceof CliError) return { ok: false, error: err };
		throw err;
	}
}

async function waitUntil(fn: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (fn()) return;
		await Bun.sleep(5);
	}
	throw new Error("timed out waiting for condition");
}

function sqliteStore(): { store: PromptStore; tmp: string } {
	const tmp = mkdtempSync(join(tmpdir(), "5x-cas-race-"));
	const db = getDb(tmp);
	runMigrations(db);
	return { store: createSqlitePromptStore(db), tmp };
}

describe("sqlite answerPrompt CAS race", () => {
	let tmp: string | undefined;

	afterEach(() => {
		closeDb();
		_resetForTest();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	test("terminal vs control-plane: exactly one winner; loser payload equals winner", async () => {
		const harness = sqliteStore();
		tmp = harness.tmp;
		const store1 = harness.store;
		const db2 = new Database(join(tmp, ".5x", "5x.db"));
		db2.exec("PRAGMA foreign_keys=ON");
		db2.exec("PRAGMA busy_timeout=5000");
		const store2 = createSqlitePromptStore(db2);
		try {
			const created = store1.createPrompt({
				kind: "choose",
				message: "Pick",
				options: ["alpha", "beta"],
			});

			const [terminal, controlPlane] = await Promise.all([
				Promise.resolve(store1.answerPrompt(created.id, "alpha", "terminal")),
				Promise.resolve(
					store2.answerPrompt(created.id, "beta", "control-plane"),
				),
			]);

			const results = [terminal, controlPlane];
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			const winner = results.find((r) => r.ok);
			const loser = results.find((r) => !r.ok);
			expect(winner).toBeDefined();
			expect(loser).toBeDefined();
			expect(loser?.prompt.answer).toBe(winner?.prompt.answer);
			expect(loser?.prompt.answeredBy).toBe(winner?.prompt.answeredBy);
			expect(
				winner?.prompt.answeredBy === "terminal" ||
					winner?.prompt.answeredBy === "control-plane",
			).toBe(true);

			const stored = store1.getPrompt(created.id);
			expect(stored?.answer).toBe(winner?.prompt.answer);
			expect(stored?.answeredBy).toBe(winner?.prompt.answeredBy);
			expect(store2.getPrompt(created.id)?.answer).toBe(stored?.answer);
		} finally {
			db2.close();
		}
	});
});

describe("TTY handler vs injected store writer", () => {
	let tmp: string | undefined;

	afterEach(() => {
		closeDb();
		_resetForTest();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	test("handler succeeds with stored winner even if TTY later produces a line; stdin and poll aborted", async () => {
		const harness = sqliteStore();
		tmp = harness.tmp;
		const inner = harness.store;
		let createdId: string | undefined;
		let gets = 0;
		const store: PromptStore = {
			createPrompt: (input) => {
				const created = inner.createPrompt(input);
				createdId = created.id;
				return created;
			},
			getPrompt: (id) => {
				gets++;
				return inner.getPrompt(id);
			},
			listOpenPrompts: (runId) => inner.listOpenPrompts(runId),
			answerPrompt: (id, answer, by) => inner.answerPrompt(id, answer, by),
			abandonPrompt: (id, reason) => inner.abandonPrompt(id, reason),
		};
		const observed: { signal?: AbortSignal } = {};

		const result = await invoke(async () => {
			const pending = promptChoose(
				{ message: "Pick", options: "a,b" },
				{
					store,
					isTTY: () => true,
					readLine: ((signal) => {
						observed.signal = signal;
						return (async () => {
							await waitUntil(() => {
								if (!createdId) return false;
								return (
									inner.getPrompt(createdId)?.answeredBy === "control-plane"
								);
							});
							return "a";
						})();
					}) as typeof readLine,
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			);
			await waitUntil(() => createdId !== undefined);
			if (!createdId) throw new Error("expected created prompt");
			inner.answerPrompt(createdId, "b", "control-plane");
			await pending;
		});

		expect(result.ok).toBe(true);
		expect(createdId).toBeDefined();
		const stored = createdId ? inner.getPrompt(createdId) : null;
		expect(stored?.answer).toBe("b");
		expect(stored?.answeredBy).toBe("control-plane");
		expect(stored?.abandonedAt).toBeNull();
		expect(observed.signal?.aborted).toBe(true);
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});
});
