import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetForTest,
	closeDb,
	getDb,
	getDbPath,
} from "../../src/db/connection.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "5x-db-conn-"));
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("getDb", () => {
	test("creates DB file and .5x directory", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			expect(db).toBeDefined();
			expect(existsSync(join(tmp, ".5x", "5x.db"))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("singleton returns same instance", () => {
		const tmp = makeTmp();
		try {
			const db1 = getDb(tmp);
			const db2 = getDb(tmp);
			expect(db1).toBe(db2);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("WAL mode is active", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			const row = db.query("PRAGMA journal_mode").get() as {
				journal_mode: string;
			};
			expect(row.journal_mode).toBe("wal");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("foreign keys are enabled", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			const row = db.query("PRAGMA foreign_keys").get() as {
				foreign_keys: number;
			};
			expect(row.foreign_keys).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("respects custom db path", () => {
		const tmp = makeTmp();
		try {
			const customPath = "custom/data.db";
			const db = getDb(tmp, customPath);
			expect(db).toBeDefined();
			expect(existsSync(join(tmp, "custom", "data.db"))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("getDbPath returns resolved path", () => {
		const tmp = makeTmp();
		try {
			getDb(tmp);
			const p = getDbPath();
			expect(p).toContain(".5x/5x.db");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("closeDb", () => {
	test("closes connection and resets singleton", () => {
		const tmp = makeTmp();
		try {
			getDb(tmp);
			closeDb();
			expect(getDbPath()).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("is idempotent", () => {
		const tmp = makeTmp();
		try {
			getDb(tmp);
			closeDb();
			closeDb(); // should not throw
			expect(getDbPath()).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
