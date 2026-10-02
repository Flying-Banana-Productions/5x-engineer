/**
 * Tests for resolveRecordsRoot — same checkout vs linked worktree.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDS_ROOT_OUTSIDE_REPO } from "../../../src/config.js";
import {
	localRecordPlanPath,
	recordPlanPath,
	resolveRecordsRoot,
} from "../../../src/records/paths.js";

describe("portable record plan paths", () => {
	test("absolute local identity becomes repo-relative and round-trips in another clone", () => {
		const root = makeTmp("5x-plan-path-");
		try {
			const rel = "docs/development/plans/alpha.md";
			expect(recordPlanPath(join(root, rel), root)).toBe(rel);
			expect(recordPlanPath("docs\\development\\plans\\alpha.md", root)).toBe(
				rel,
			);
			expect(localRecordPlanPath(rel, root)).toBe(join(root, rel));
			for (const legacy of [
				"/home/another-user/old-repo/alpha.md",
				"C:\\Users\\another-user\\repo\\alpha.md",
			]) {
				expect(localRecordPlanPath(legacy, root, rel)).toBe(join(root, rel));
				expect(() => localRecordPlanPath(legacy, root)).toThrow("unambiguous");
			}
			for (const invalid of [
				"../alpha.md",
				"docs/../../alpha.md",
				"..\\alpha.md",
				".",
			]) {
				expect(() => recordPlanPath(invalid, root)).toThrow("repo-relative");
			}
			expect(() => recordPlanPath("/outside/alpha.md", root)).toThrow(
				"outside",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function makeTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("resolveRecordsRoot", () => {
	test("same checkout: abs path equals config abs; rel is POSIX default", () => {
		const root = makeTmp("5x-records-paths-same-");
		try {
			const recordsConfigAbs = join(root, "docs", "development", "runs");
			const resolved = resolveRecordsRoot({
				recordsConfigAbs,
				controlPlaneRoot: root,
				effectiveWorkdir: root,
			});
			expect(resolved.recordsAbsPath).toBe(recordsConfigAbs);
			expect(resolved.recordsRelPath).toBe("docs/development/runs");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("linked worktree: abs is re-rooted; rel unchanged", () => {
		const root = makeTmp("5x-records-paths-cp-");
		const worktree = makeTmp("5x-records-paths-wt-");
		try {
			const recordsConfigAbs = join(root, "docs", "development", "runs");
			const resolved = resolveRecordsRoot({
				recordsConfigAbs,
				controlPlaneRoot: root,
				effectiveWorkdir: worktree,
			});
			expect(resolved.recordsRelPath).toBe("docs/development/runs");
			expect(resolved.recordsAbsPath).toBe(
				join(worktree, "docs", "development", "runs"),
			);
			expect(resolved.recordsAbsPath).not.toBe(recordsConfigAbs);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("outside-repo records root throws RECORDS_ROOT_OUTSIDE_REPO", () => {
		const root = makeTmp("5x-records-paths-inside-");
		const outside = makeTmp("5x-records-paths-outside-");
		try {
			expect(() =>
				resolveRecordsRoot({
					recordsConfigAbs: outside,
					controlPlaneRoot: root,
					effectiveWorkdir: root,
				}),
			).toThrow(RECORDS_ROOT_OUTSIDE_REPO);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
