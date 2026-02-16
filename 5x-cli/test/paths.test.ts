import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizePlanPath } from "../src/paths.js";

describe("canonicalizePlanPath", () => {
	test("returns a stable absolute path for missing files", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-missing-"));
		try {
			const p = resolve(join(tmp, "missing.md"));
			expect(canonicalizePlanPath(p)).toBe(p);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("resolves symlinks to real path when possible", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-"));
		try {
			const target = join(tmp, "plan.md");
			const link = join(tmp, "plan-link.md");
			writeFileSync(target, "# Plan\n");
			symlinkSync(target, link);
			expect(canonicalizePlanPath(link)).toBe(canonicalizePlanPath(target));
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
