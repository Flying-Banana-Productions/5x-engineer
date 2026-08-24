/**
 * Tests for the local focus pointer helpers.
 */

import { afterEach, describe, expect, test } from "bun:test";
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
	CURRENT_RUN_FILENAME,
	clearPointerIfMatch,
	currentRunPath,
	readPointer,
	writePointer,
} from "../../../src/commands/run-pointer.js";

const RUN_A = "run_aaaaaaaa01";
const RUN_B = "run_bbbbbbbb02";

const temps: string[] = [];

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("currentRunPath", () => {
	test("relative stateDir resolves under controlPlaneRoot", () => {
		const root = tmpDir("5x-ptr-rel-");
		expect(currentRunPath(root, ".5x")).toBe(
			join(root, ".5x", CURRENT_RUN_FILENAME),
		);
	});

	test("absolute stateDir resolves to join(stateDir, current-run) and is not prefixed", () => {
		const root = tmpDir("5x-ptr-root-");
		const abs = tmpDir("5x-ptr-abs-");
		const result = currentRunPath(root, abs);
		expect(result).toBe(join(abs, CURRENT_RUN_FILENAME));
		expect(result).not.toBe(join(root, abs, CURRENT_RUN_FILENAME));
		expect(result.startsWith(root)).toBe(false);
	});
});

describe("readPointer / writePointer / clearPointerIfMatch", () => {
	test("write/read round-trip including trailing newline", () => {
		const dir = tmpDir("5x-ptr-rw-");
		const path = join(dir, ".5x", CURRENT_RUN_FILENAME);
		writePointer(path, RUN_A);
		expect(readFileSync(path, "utf-8")).toBe(`${RUN_A}\n`);
		expect(readPointer(path)).toBe(RUN_A);
	});

	test("write overwrites existing contents", () => {
		const dir = tmpDir("5x-ptr-ow-");
		const path = join(dir, CURRENT_RUN_FILENAME);
		writePointer(path, RUN_A);
		writePointer(path, RUN_B);
		expect(readPointer(path)).toBe(RUN_B);
	});

	test("write creates the parent directory", () => {
		const dir = tmpDir("5x-ptr-mkdir-");
		const path = join(dir, "nested", "state", CURRENT_RUN_FILENAME);
		expect(existsSync(join(dir, "nested"))).toBe(false);
		writePointer(path, RUN_A);
		expect(readPointer(path)).toBe(RUN_A);
	});

	test("missing file returns null", () => {
		const dir = tmpDir("5x-ptr-miss-");
		expect(readPointer(join(dir, CURRENT_RUN_FILENAME))).toBeNull();
	});

	test("malformed empty file returns empty string", () => {
		const dir = tmpDir("5x-ptr-empty-");
		const path = join(dir, CURRENT_RUN_FILENAME);
		writeFileSync(path, "  \n", "utf-8");
		expect(readPointer(path)).toBe("");
	});

	test("clear matching unlinks the file", () => {
		const dir = tmpDir("5x-ptr-clr-");
		const path = join(dir, CURRENT_RUN_FILENAME);
		writePointer(path, RUN_A);
		expect(clearPointerIfMatch(path, RUN_A)).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(readPointer(path)).toBeNull();
	});

	test("refuse to clear a mismatch", () => {
		const dir = tmpDir("5x-ptr-mismatch-");
		const path = join(dir, CURRENT_RUN_FILENAME);
		writePointer(path, RUN_B);
		expect(clearPointerIfMatch(path, RUN_A)).toBe(false);
		expect(readPointer(path)).toBe(RUN_B);
	});

	test("missing file clear is a no-op", () => {
		const dir = tmpDir("5x-ptr-noop-");
		const path = join(dir, CURRENT_RUN_FILENAME);
		expect(clearPointerIfMatch(path, RUN_A)).toBe(false);
		expect(existsSync(path)).toBe(false);
	});

	test("write via relative currentRunPath lands under controlPlaneRoot", () => {
		const root = tmpDir("5x-ptr-relw-");
		const path = currentRunPath(root, ".5x");
		writePointer(path, RUN_A);
		expect(path).toBe(join(root, ".5x", CURRENT_RUN_FILENAME));
		expect(readPointer(path)).toBe(RUN_A);
	});

	test("write via absolute currentRunPath lands in stateDir, not under controlPlaneRoot", () => {
		const root = tmpDir("5x-ptr-absw-root-");
		const abs = tmpDir("5x-ptr-absw-state-");
		const path = currentRunPath(root, abs);
		writePointer(path, RUN_A);
		expect(path).toBe(join(abs, CURRENT_RUN_FILENAME));
		expect(readPointer(path)).toBe(RUN_A);
		expect(existsSync(join(root, abs, CURRENT_RUN_FILENAME))).toBe(false);
	});
});

describe("currentRunPath parent creation via writePointer", () => {
	test("relative stateDir parent is created on write", () => {
		const root = tmpDir("5x-ptr-parent-");
		const path = currentRunPath(root, ".5x");
		expect(existsSync(join(root, ".5x"))).toBe(false);
		writePointer(path, RUN_A);
		expect(existsSync(join(root, ".5x"))).toBe(true);
		expect(readPointer(path)).toBe(RUN_A);
	});
});
