/**
 * Phase 8: public RecordStore exports and compatibility sweep.
 *
 * Locks the control-plane / package barrels, forbids identity/SQL/fs helpers
 * on the store barrel, and confirms command files plus the phase-execution
 * skill hot loop did not grow new primitives.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as controlPlane from "../../../src/control-plane/index.js";
import {
	createMemoryRecordStore,
	createWorkingTreeRecordStore,
	RECORD_LINE_SCHEMA_VERSION,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/index.js";
import {
	loadOrCreateInstallationIdentity,
	resolveRecorder,
} from "../../../src/records/identity.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../src");

const SQLITE_IMPORT = /from\s+["']bun:sqlite["']/;

describe("RecordStore public exports", () => {
	test("package barrel re-exports factories, envelope helpers, and types", () => {
		expect(typeof createMemoryRecordStore).toBe("function");
		expect(typeof createWorkingTreeRecordStore).toBe("function");
		expect(typeof recordedEnvelope).toBe("function");
		expect(typeof stepIdempotencyKey).toBe("function");
		expect(typeof RecordStoreError).toBe("function");
		expect(RECORD_LINE_SCHEMA_VERSION).toBe(1);
		expect(RUN_RECORD_FORMAT_VERSION).toBe(1);
		expect(typeof loadOrCreateInstallationIdentity).toBe("function");
		expect(typeof resolveRecorder).toBe("function");
	});

	test("control-plane barrel exports the same store surface", () => {
		expect(typeof controlPlane.createMemoryRecordStore).toBe("function");
		expect(typeof controlPlane.createWorkingTreeRecordStore).toBe("function");
		expect(typeof controlPlane.recordedEnvelope).toBe("function");
		expect(typeof controlPlane.stepIdempotencyKey).toBe("function");
		expect(typeof controlPlane.RecordStoreError).toBe("function");
		expect(controlPlane.RECORD_LINE_SCHEMA_VERSION).toBe(1);
		expect(controlPlane.RUN_RECORD_FORMAT_VERSION).toBe(1);
	});

	test("control-plane barrel does not export identity-file I/O or SQL helpers", () => {
		const keys = Object.keys(controlPlane);
		expect(keys).not.toContain("loadOrCreateInstallationIdentity");
		expect(keys).not.toContain("resolveRecorder");
		expect(keys).not.toContain("identityDir");
		expect(keys).not.toContain("getDb");
		expect(keys).not.toContain("openDbReadOnly");
		expect(keys).not.toContain("fsyncDir");
		expect(keys).not.toContain("recoverRunDir");
		expect(keys).not.toContain("decodeJsonlFile");
	});
});

describe("Phase 8 compatibility sweep", () => {
	test("plan / records / prompt handlers do not import bun:sqlite", () => {
		for (const rel of [
			"commands/plan-v1.handler.ts",
			"commands/records.handler.ts",
			"commands/prompt.handler.ts",
		]) {
			const text = readFileSync(join(SRC, rel), "utf8");
			expect(text).not.toMatch(SQLITE_IMPORT);
		}
	});

	test("5x-phase-execution hot loop still calls phase finish / run record / commit", () => {
		const skill = readFileSync(
			join(SRC, "skills/base/5x-phase-execution/SKILL.tmpl.md"),
			"utf8",
		);
		expect(skill).toContain("5x phase finish");
		expect(skill).toContain("5x run record");
		expect(skill).toContain("5x commit");
		expect(skill).not.toContain("5x records index");
		expect(skill).not.toContain("5x records backfill");
	});
});
