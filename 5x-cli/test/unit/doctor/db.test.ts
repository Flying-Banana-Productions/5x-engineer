/**
 * Unit tests for the database doctor check.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	_migrations,
	getMaxKnownSchemaVersion,
	getSchemaVersion,
	runMigrations,
} from "../../../src/db/schema.js";
import { dbCheck } from "../../../src/doctor/checks/db.js";
import type { DoctorCheckContext } from "../../../src/doctor/types.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-db-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function doctorCtx(projectRoot: string): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
	};
}

function createMigratedDb(projectRoot: string): string {
	const db = getDb(projectRoot);
	runMigrations(db);
	const dbPath = resolve(projectRoot, ".5x", "5x.db");
	closeDb();
	_resetForTest();
	return dbPath;
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("db detect", () => {
	test("missing file → DB_MISSING and does not create a file", async () => {
		const tmp = makeTmp();
		try {
			const ctx = doctorCtx(tmp);
			expect(existsSync(ctx.dbPath)).toBe(false);
			const findings = await dbCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("DB_MISSING");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
			expect(findings[0]?.remediation).toContain("5x init");
			expect(findings[0]?.remediation).toContain("will not create");
			expect(existsSync(ctx.dbPath)).toBe(false);
			expect(existsSync(join(tmp, ".5x"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unreadable file → DB_UNREADABLE, not thrown", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp);
			writeFileSync(ctx.dbPath, "not a sqlite database");
			const findings = await dbCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("DB_UNREADABLE");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
			expect(findings[0]?.remediation).toContain("will not delete");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("outdated schema is reported without migration", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp);
			const db = new Database(ctx.dbPath);
			const migration1 = _migrations.find((m) => m.version === 1);
			if (!migration1) throw new Error("missing migration 1");
			migration1.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (1)");
			expect(getSchemaVersion(db)).toBe(1);
			db.close();

			const findings = await dbCheck.run(ctx);
			const behind = findings.find((f) => f.code === "DB_SCHEMA_BEHIND");
			expect(behind?.status).toBe("fail");
			expect(behind?.fixable).toBe(false);
			expect(behind?.remediation).toBe("5x upgrade");
			expect(behind?.message).toContain("v1");
			expect(behind?.message).toContain(`v${getMaxKnownSchemaVersion()}`);

			const after = new Database(ctx.dbPath, { readonly: true });
			try {
				expect(getSchemaVersion(after)).toBe(1);
			} finally {
				after.close();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("schema ahead → DB_SCHEMA_AHEAD without mutation", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const db = new Database(dbPath);
			db.exec("INSERT INTO schema_version (version) VALUES (999)");
			expect(getSchemaVersion(db)).toBe(999);
			db.close();

			const findings = await dbCheck.run(doctorCtx(tmp));
			const ahead = findings.find((f) => f.code === "DB_SCHEMA_AHEAD");
			expect(ahead?.status).toBe("fail");
			expect(ahead?.fixable).toBe(false);
			expect(ahead?.message).toContain("v999");
			expect(ahead?.message).toContain(`v${getMaxKnownSchemaVersion()}`);
			expect(ahead?.message).toContain("Upgrade the CLI");

			const after = new Database(dbPath, { readonly: true });
			try {
				expect(getSchemaVersion(after)).toBe(999);
			} finally {
				after.close();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("healthy migrated DB → DB_OK with version", async () => {
		const tmp = makeTmp();
		try {
			createMigratedDb(tmp);
			const findings = await dbCheck.run(doctorCtx(tmp));
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("DB_OK");
			expect(findings[0]?.status).toBe("ok");
			expect(findings[0]?.fixable).toBe(false);
			expect(findings[0]?.message).toContain(
				`schema v${getMaxKnownSchemaVersion()}`,
			);
			expect(findings[0]?.message).toContain("integrity ok");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("corrupt pages → DB_INTEGRITY finding, not thrown", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp);
			const db = new Database(ctx.dbPath);
			db.exec("PRAGMA page_size=4096");
			db.exec("CREATE TABLE t(x TEXT)");
			for (let i = 0; i < 200; i++) {
				db.exec(
					`INSERT INTO t VALUES ('row-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')`,
				);
			}
			db.close();

			const buf = Buffer.from(readFileSync(ctx.dbPath));
			buf.fill(0, 4096, Math.min(buf.length, 8192));
			writeFileSync(ctx.dbPath, buf);

			const findings = await dbCheck.run(ctx);
			expect(findings.some((f) => f.code === "DB_INTEGRITY")).toBe(true);
			expect(findings.every((f) => f.status !== undefined)).toBe(true);
			const integrity = findings.find((f) => f.code === "DB_INTEGRITY");
			expect(integrity?.status).toBe("fail");
			expect(integrity?.fixable).toBe(false);
			expect(integrity?.remediation).toContain("will not delete");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("check has no fix function", () => {
		expect(dbCheck.fix).toBeUndefined();
	});

	test("detect path does not import getDb or resolveDbContext", () => {
		const src = readFileSync(
			join(import.meta.dir, "../../../src/doctor/checks/db.ts"),
			"utf8",
		);
		expect(src).not.toMatch(/\bgetDb\s*\(/);
		expect(src).not.toMatch(/\bimport\s*\{[^}]*\bgetDb\b/);
		expect(src).not.toMatch(/\bresolveDbContext\b/);
	});
});
