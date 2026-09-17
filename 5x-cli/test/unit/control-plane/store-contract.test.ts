import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryPromptStore,
	createSqlitePromptStore,
	type PromptStore,
	PromptStoreError,
} from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoreHarness {
	store: PromptStore;
	ensureRun: (id: string) => void;
	cleanup: () => void;
}

function memoryHarness(): StoreHarness {
	return {
		store: createMemoryPromptStore(),
		ensureRun: () => {},
		cleanup: () => {},
	};
}

function sqliteHarness(): StoreHarness {
	const tmp = mkdtempSync(join(tmpdir(), "5x-prompt-store-"));
	const db = getDb(tmp);
	runMigrations(db);
	return {
		store: createSqlitePromptStore(db),
		ensureRun: (id) => {
			createRunV1(db, { id, planPath: "/plan.md" });
		},
		cleanup: () => {
			closeDb();
			_resetForTest();
			rmSync(tmp, { recursive: true });
		},
	};
}

const backends: Array<{ name: string; setup: () => StoreHarness }> = [
	{ name: "memory", setup: memoryHarness },
	{ name: "sqlite", setup: sqliteHarness },
];

function idsOf(records: Array<{ id: string }>): string[] {
	return records.map((r) => r.id);
}

for (const backend of backends) {
	describe(`PromptStore contract (${backend.name})`, () => {
		let store: PromptStore;
		let ensureRun: (id: string) => void;
		let cleanup: () => void;

		beforeEach(() => {
			const harness = backend.setup();
			store = harness.store;
			ensureRun = harness.ensureRun;
			cleanup = harness.cleanup;
		});

		afterEach(() => {
			cleanup();
		});

		test("createPrompt then getPrompt round-trips UUID, kind, message, options, default, null answer", () => {
			const created = store.createPrompt({
				kind: "choose",
				message: "Pick one",
				options: ["alpha", "beta"],
				defaultValue: "alpha",
			});

			expect(created.id).toMatch(UUID_RE);
			expect(created.kind).toBe("choose");
			expect(created.message).toBe("Pick one");
			expect(created.options).toEqual(["alpha", "beta"]);
			expect(created.defaultValue).toBe("alpha");
			expect(created.runId).toBeNull();
			expect(created.answer).toBeNull();
			expect(created.answeredAt).toBeNull();
			expect(created.answeredBy).toBeNull();
			expect(created.abandonedAt).toBeNull();
			expect(created.abandonReason).toBeNull();
			expect(created.createdAt.length).toBeGreaterThan(0);

			const loaded = store.getPrompt(created.id);
			expect(loaded).not.toBeNull();
			expect(loaded).toEqual(created);
		});

		test("listOpenPrompts omits answered and abandoned; runId filters; null run_id only in unfiltered list", () => {
			ensureRun("run_aaa");
			ensureRun("run_bbb");

			const openA = store.createPrompt({
				runId: "run_aaa",
				kind: "input",
				message: "a",
			});
			const openB = store.createPrompt({
				runId: "run_bbb",
				kind: "input",
				message: "b",
			});
			const standalone = store.createPrompt({
				kind: "input",
				message: "standalone",
			});
			const answered = store.createPrompt({
				runId: "run_aaa",
				kind: "input",
				message: "answered",
			});
			store.answerPrompt(answered.id, "done", "terminal");
			const abandoned = store.createPrompt({
				runId: "run_aaa",
				kind: "input",
				message: "abandoned",
			});
			store.abandonPrompt(abandoned.id, "timeout");

			const allOpen = store.listOpenPrompts();
			expect(idsOf(allOpen).sort()).toEqual(
				[openA.id, openB.id, standalone.id].sort(),
			);
			expect(allOpen.some((p) => p.id === answered.id)).toBe(false);
			expect(allOpen.some((p) => p.id === abandoned.id)).toBe(false);

			const onlyA = store.listOpenPrompts("run_aaa");
			expect(idsOf(onlyA)).toEqual([openA.id]);
			expect(onlyA.some((p) => p.id === standalone.id)).toBe(false);

			const onlyB = store.listOpenPrompts("run_bbb");
			expect(idsOf(onlyB)).toEqual([openB.id]);
			expect(onlyB.some((p) => p.runId === null)).toBe(false);
		});

		test("listAnsweredPrompts returns answered run-scoped prompts and omits open/abandoned/other runs", () => {
			ensureRun("run_aaa");
			ensureRun("run_bbb");

			const openA = store.createPrompt({
				runId: "run_aaa",
				kind: "input",
				message: "open",
			});
			const answeredA = store.createPrompt({
				runId: "run_aaa",
				kind: "confirm",
				message: "answered-a",
			});
			store.answerPrompt(answeredA.id, "true", "terminal");
			const answeredB = store.createPrompt({
				runId: "run_bbb",
				kind: "input",
				message: "answered-b",
			});
			store.answerPrompt(answeredB.id, "ok", "terminal");
			const abandoned = store.createPrompt({
				runId: "run_aaa",
				kind: "input",
				message: "abandoned",
			});
			store.abandonPrompt(abandoned.id, "timeout");
			store.createPrompt({
				kind: "input",
				message: "standalone",
			});

			expect(store.listAnsweredPrompts).toBeDefined();
			const listed = store.listAnsweredPrompts?.("run_aaa") ?? [];
			expect(idsOf(listed)).toEqual([answeredA.id]);
			expect(listed[0]?.answer).toBe("true");
			expect(listed.some((p) => p.id === openA.id)).toBe(false);
			expect(listed.some((p) => p.id === answeredB.id)).toBe(false);
			expect(listed.some((p) => p.id === abandoned.id)).toBe(false);
		});

		test("first answerPrompt wins; second returns ok:false with the first answer; answered_by unchanged", () => {
			const created = store.createPrompt({
				kind: "choose",
				message: "Pick",
				options: ["x", "y"],
			});

			const first = store.answerPrompt(created.id, "x", "terminal");
			expect(first.ok).toBe(true);
			expect(first.prompt.answer).toBe("x");
			expect(first.prompt.answeredBy).toBe("terminal");
			expect(first.prompt.answeredAt).not.toBeNull();

			const second = store.answerPrompt(created.id, "y", "control-plane");
			expect(second.ok).toBe(false);
			expect(second.prompt.answer).toBe("x");
			expect(second.prompt.answeredBy).toBe("terminal");
			expect(second.prompt.answeredAt).toBe(first.prompt.answeredAt);

			const stored = store.getPrompt(created.id);
			expect(stored?.answer).toBe("x");
			expect(stored?.answeredBy).toBe("terminal");
		});

		test("Promise.all two answerPrompt calls yields exactly one ok:true", async () => {
			const created = store.createPrompt({
				kind: "input",
				message: "race",
			});

			const [a, b] = await Promise.all([
				Promise.resolve(store.answerPrompt(created.id, "one", "terminal")),
				Promise.resolve(store.answerPrompt(created.id, "two", "control-plane")),
			]);

			const results = [a, b];
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => !r.ok)).toHaveLength(1);
			expect(a.prompt.answer).toBe(b.prompt.answer);
			expect(a.prompt.answeredBy).toBe(b.prompt.answeredBy);

			const stored = store.getPrompt(created.id);
			expect(stored?.answer).toBe(a.prompt.answer);
			expect(stored?.answeredBy).toBe(a.prompt.answeredBy);
		});

		test("abandonPrompt then answerPrompt loses; answerPrompt then abandonPrompt loses", () => {
			const toAbandon = store.createPrompt({
				kind: "confirm",
				message: "abandon first",
			});
			const abandoned = store.abandonPrompt(toAbandon.id, "eof");
			expect(abandoned.ok).toBe(true);
			expect(abandoned.prompt.abandonReason).toBe("eof");
			expect(abandoned.prompt.abandonedAt).not.toBeNull();

			const answerAfter = store.answerPrompt(toAbandon.id, "true", "terminal");
			expect(answerAfter.ok).toBe(false);
			expect(answerAfter.prompt.answer).toBeNull();
			expect(answerAfter.prompt.answeredBy).toBeNull();
			expect(answerAfter.prompt.abandonReason).toBe("eof");

			const toAnswer = store.createPrompt({
				kind: "confirm",
				message: "answer first",
			});
			const answered = store.answerPrompt(toAnswer.id, "false", "default");
			expect(answered.ok).toBe(true);
			expect(answered.prompt.answer).toBe("false");
			expect(answered.prompt.answeredBy).toBe("default");

			const abandonAfter = store.abandonPrompt(toAnswer.id, "timeout");
			expect(abandonAfter.ok).toBe(false);
			expect(abandonAfter.prompt.answer).toBe("false");
			expect(abandonAfter.prompt.answeredBy).toBe("default");
			expect(abandonAfter.prompt.abandonedAt).toBeNull();
			expect(abandonAfter.prompt.abandonReason).toBeNull();
		});

		test("abandoned rows are not open", () => {
			const created = store.createPrompt({
				kind: "input",
				message: "bye",
			});
			const result = store.abandonPrompt(created.id, "non-interactive");
			expect(result.ok).toBe(true);
			expect(store.listOpenPrompts()).toEqual([]);
			expect(store.getPrompt(created.id)?.abandonReason).toBe(
				"non-interactive",
			);
		});

		test("answerPrompt and abandonPrompt throw PROMPT_NOT_FOUND for missing id", () => {
			expect(() => store.answerPrompt("missing", "x", "terminal")).toThrow(
				PromptStoreError,
			);
			try {
				store.answerPrompt("missing", "x", "terminal");
			} catch (err) {
				expect(err).toBeInstanceOf(PromptStoreError);
				expect((err as PromptStoreError).code).toBe("PROMPT_NOT_FOUND");
			}

			try {
				store.abandonPrompt("missing", "timeout");
			} catch (err) {
				expect(err).toBeInstanceOf(PromptStoreError);
				expect((err as PromptStoreError).code).toBe("PROMPT_NOT_FOUND");
			}

			expect(store.getPrompt("missing")).toBeNull();
		});
	});
}

describe("SqlitePromptStore shared-file CAS", () => {
	test("two stores on one DB still CAS correctly (shared file)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-prompt-store-shared-"));
		let db2: Database | undefined;
		try {
			const db = getDb(tmp);
			runMigrations(db);
			const dbPath = join(tmp, ".5x", "5x.db");
			db2 = new Database(dbPath);
			db2.exec("PRAGMA foreign_keys=ON");
			db2.exec("PRAGMA busy_timeout=5000");

			const store1 = createSqlitePromptStore(db);
			const store2 = createSqlitePromptStore(db2);

			const created = store1.createPrompt({
				kind: "input",
				message: "shared-file race",
			});
			expect(store2.getPrompt(created.id)?.message).toBe("shared-file race");

			const [a, b] = await Promise.all([
				Promise.resolve(store1.answerPrompt(created.id, "from-1", "terminal")),
				Promise.resolve(
					store2.answerPrompt(created.id, "from-2", "control-plane"),
				),
			]);

			expect([a, b].filter((r) => r.ok)).toHaveLength(1);
			expect(a.prompt.answer).toBe(b.prompt.answer);
			expect(a.prompt.answeredBy).toBe(b.prompt.answeredBy);

			const from1 = store1.getPrompt(created.id);
			const from2 = store2.getPrompt(created.id);
			expect(from1?.answer).toBe(from2?.answer);
			expect(from1?.answeredBy).toBe(from2?.answeredBy);
			expect(from1?.answer === "from-1" || from1?.answer === "from-2").toBe(
				true,
			);
		} finally {
			db2?.close();
			closeDb();
			_resetForTest();
			rmSync(tmp, { recursive: true });
		}
	});
});
