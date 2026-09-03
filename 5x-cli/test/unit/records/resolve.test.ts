/**
 * Unit tests for progress resolution: ancestor prune, diverged pair, missing ref.
 * Git I/O is mocked via spyOn(subprocess.execGit).
 */

import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	envelopeFromProgress,
	formatAgeAgo,
	formatProgressSourceLine,
	isAncestorInGraph,
	parseLogNameOnly,
	parseRevListParents,
	resolvePlanProgress,
} from "../../../src/records/resolve.js";
import { subprocess } from "../../../src/utils/subprocess.js";

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({
	stdout: "",
	stderr,
	exitCode,
});

let execGitSpy: Mock<typeof subprocess.execGit>;

afterEach(() => {
	execGitSpy?.mockRestore();
});

function mockGit(
	...rules: Array<
		[
			(args: string[], cwd?: string) => boolean,
			{ stdout: string; stderr: string; exitCode: number },
		]
	>
) {
	execGitSpy = spyOn(subprocess, "execGit").mockImplementation(
		async (args: string[], cwd: string) => {
			for (const [match, response] of rules) {
				if (match(args, cwd)) return response;
			}
			return fail(`Unexpected git call: git ${args.join(" ")}`);
		},
	);
	return execGitSpy;
}

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccccccccccccccccc";
const D = "dddddddddddddddddddddddddddddddddddddddd";

const PLAN = "docs/development/foo.md";
const PLAN_MD_A = `# Foo

## Phase 1: First

- [x] a
`;
const PLAN_MD_B = `# Foo

## Phase 1: First

- [x] a

## Phase 2: Second

- [x] b
`;
const PLAN_MD_HALF = `# Foo

## Phase 1: First

- [x] a

## Phase 2: Second

- [ ] b
`;

describe("parse helpers", () => {
	test("parseRevListParents and isAncestorInGraph prune ancestors", () => {
		const parents = parseRevListParents(`${B} ${A}\n${A}`);
		expect(isAncestorInGraph(parents, A, B)).toBe(true);
		expect(isAncestorInGraph(parents, B, A)).toBe(false);
	});

	test("parseLogNameOnly groups files under commits", () => {
		expect(parseLogNameOnly(`${B}\n${PLAN}\n\n${A}\n${PLAN}\n`)).toEqual([
			{ commit: B, files: [PLAN] },
			{ commit: A, files: [PLAN] },
		]);
	});
});

describe("resolvePlanProgress", () => {
	test("missing 5x ref is skipped; untouched HEAD yields checkout fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-resolve-missing-"));
		try {
			mockGit(
				[(args) => args[0] === "for-each-ref", ok("")],
				[
					(args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
					ok(A),
				],
				[(args) => args[0] === "rev-parse", fail("missing")],
				[(args) => args[0] === "rev-list", ok(A)],
				[(args) => args[0] === "log", ok("")],
			);
			const resolved = await resolvePlanProgress({
				workdir: dir,
				planPath: join(dir, PLAN),
				planSlug: "foo",
				recordsRelPath: "docs/development/runs",
			});
			expect(resolved.markdown).toBeNull();
			expect(resolved.source.kind).toBe("HEAD");
			expect(resolved.commit).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ancestor prune keeps the descendant commit", async () => {
		mockGit(
			[
				(args) =>
					args[0] === "for-each-ref" && args[1] === "--format=%(refname)",
				ok("refs/heads/5x/foo"),
			],
			[
				(args) =>
					args[0] === "for-each-ref" && String(args[1]).includes("objectname"),
				ok(`${B}\trefs/heads/5x/foo\t1700000000`),
			],
			[
				(args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
				ok(A),
			],
			[(args) => args[0] === "rev-list", ok(`${B} ${A}\n${A}`)],
			[(args) => args[0] === "log", ok(`${B}\n${PLAN}\n\n${A}\n${PLAN}\n`)],
			[
				(args) => args[0] === "show" && args[1] === `${B}:${PLAN}`,
				ok(PLAN_MD_B),
			],
			[(args) => args[0] === "show", fail("missing")],
		);
		const resolved = await resolvePlanProgress({
			workdir: "/repo",
			planPath: `/repo/${PLAN}`,
			planSlug: "foo",
			recordsRelPath: "docs/development/runs",
		});
		expect(resolved.source.label).toBe("5x/foo");
		expect(resolved.source.kind).toBe("branch");
		expect(resolved.commit).toBe(B);
		expect(resolved.markdown).toContain("Phase 2");
		expect(resolved.diverged_sources).toBeUndefined();
	});

	test("diverged pair reports both labels and max completion markdown", async () => {
		mockGit(
			[
				(args) =>
					args[0] === "for-each-ref" && args[1] === "--format=%(refname)",
				ok("refs/heads/5x/foo\nrefs/remotes/origin/5x/foo"),
			],
			[
				(args) =>
					args[0] === "for-each-ref" && String(args[1]).includes("objectname"),
				ok(
					`${C}\trefs/heads/5x/foo\t1700000000\n${D}\trefs/remotes/origin/5x/foo\t1700000100`,
				),
			],
			[
				(args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
				ok(A),
			],
			[(args) => args[0] === "rev-list", ok(`${C} ${A}\n${D} ${A}\n${A}`)],
			[
				(args) => args[0] === "log",
				ok(`${C}\n${PLAN}\n\n${D}\n${PLAN}\n\n${A}\n${PLAN}\n`),
			],
			[
				(args) => args[0] === "show" && args[1] === `${C}:${PLAN}`,
				ok(PLAN_MD_B),
			],
			[
				(args) => args[0] === "show" && args[1] === `${D}:${PLAN}`,
				ok(PLAN_MD_HALF),
			],
			[(args) => args[0] === "show", fail("missing")],
		);
		const resolved = await resolvePlanProgress({
			workdir: "/repo",
			planPath: `/repo/${PLAN}`,
			planSlug: "foo",
			recordsRelPath: "docs/development/runs",
			nowMs: 1700001000 * 1000,
		});
		expect(resolved.source.kind).toBe("diverged");
		expect(resolved.source.label).toBe("diverged");
		expect(resolved.diverged_sources?.map((s) => s.label).sort()).toEqual([
			"5x/foo",
			"origin/5x/foo",
		]);
		expect(resolved.markdown).toContain("Phase 2");
		expect(resolved.markdown).toContain("- [x] b");
		const env = envelopeFromProgress(resolved);
		expect(env.source).toBe("diverged");
		expect(env.diverged_sources?.length).toBe(2);
		const remote = resolved.diverged_sources?.find((s) => s.kind === "remote");
		expect(remote?.age_seconds).toBe(1700001000 - 1700000100);
	});

	test("checkout file is used when no git survivor exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-resolve-disk-"));
		try {
			mkdirSync(join(dir, "docs", "development"), { recursive: true });
			writeFileSync(join(dir, PLAN), PLAN_MD_A);
			mockGit(
				[(args) => args[0] === "for-each-ref", ok("")],
				[
					(args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
					ok(A),
				],
				[(args) => args[0] === "rev-parse", fail("missing")],
				[(args) => args[0] === "rev-list", ok(A)],
				[(args) => args[0] === "log", ok("")],
			);
			const resolved = await resolvePlanProgress({
				workdir: dir,
				planPath: join(dir, PLAN),
				planSlug: "foo",
				recordsRelPath: "docs/development/runs",
			});
			expect(resolved.source.kind).toBe("HEAD");
			expect(resolved.markdown).toContain("Phase 1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("mapped worktree file wins when worktree HEAD cannot be resolved", async () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-resolve-wt-"));
		const wt = join(dir, "wt");
		try {
			mkdirSync(join(wt, "docs", "development"), { recursive: true });
			writeFileSync(join(wt, PLAN), PLAN_MD_B);
			mockGit(
				[(args) => args[0] === "for-each-ref", ok("")],
				[
					(args, cwd) =>
						args[0] === "rev-parse" &&
						args.includes("HEAD^{commit}") &&
						cwd === dir,
					ok(A),
				],
				[(args) => args[0] === "rev-parse", fail("missing")],
				[(args) => args[0] === "rev-list", ok(A)],
				[(args) => args[0] === "log", ok(`${A}\n${PLAN}\n`)],
				[
					(args) => args[0] === "show" && args[1] === `${A}:${PLAN}`,
					ok(PLAN_MD_A),
				],
				[(args) => args[0] === "show", fail("missing")],
			);
			const resolved = await resolvePlanProgress({
				workdir: dir,
				planPath: join(dir, PLAN),
				planSlug: "foo",
				recordsRelPath: "docs/development/runs",
				worktreePath: wt,
			});
			expect(resolved.source.kind).toBe("worktree");
			expect(resolved.markdown).toContain("- [x] b");
			expect(resolved.commit).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("plans.branch is a candidate when the plan exists only on that ref", async () => {
		mockGit(
			[(args) => args[0] === "for-each-ref", ok("")],
			[
				(args) =>
					args[0] === "rev-parse" && args.includes("release/plans^{commit}"),
				ok(B),
			],
			[
				(args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
				ok(A),
			],
			[(args) => args[0] === "rev-parse", fail("missing")],
			[(args) => args[0] === "rev-list", ok(`${B} ${A}\n${A}`)],
			[
				(args) =>
					args[0] === "log" && args.includes("-1") && args.includes("HEAD"),
				ok(""),
			],
			[(args) => args[0] === "log" && args.includes("-1"), ok(B)],
			[(args) => args[0] === "log", ok(`${B}\n${PLAN}\n`)],
			[
				(args) => args[0] === "show" && args[1] === `${B}:${PLAN}`,
				ok(PLAN_MD_B),
			],
			[(args) => args[0] === "show", fail("missing")],
		);
		const resolved = await resolvePlanProgress({
			workdir: "/repo",
			planPath: `/repo/${PLAN}`,
			planSlug: "foo",
			recordsRelPath: "docs/development/runs",
			plansBranch: "release/plans",
		});
		expect(resolved.source.kind).toBe("branch");
		expect(resolved.source.label).toBe("release/plans");
		expect(resolved.source.ref).toBe("release/plans");
		expect(resolved.commit).toBe(B);
		expect(resolved.markdown).toContain("Phase 2");
	});
});

describe("text provenance helpers", () => {
	test("formatProgressSourceLine omits checkout sources and formats remote age", () => {
		expect(
			formatProgressSourceLine({ kind: "worktree", label: "worktree" }),
		).toBeNull();
		expect(
			formatProgressSourceLine({ kind: "HEAD", label: "HEAD" }),
		).toBeNull();
		expect(
			formatProgressSourceLine({
				kind: "remote",
				label: "origin/5x/foo",
				age_seconds: 7200,
			}),
		).toBe("source: origin/5x/foo (fetched 2h ago)");
	});

	test("formatAgeAgo buckets seconds", () => {
		expect(formatAgeAgo(10)).toBe("fetched just now");
		expect(formatAgeAgo(120)).toBe("fetched 2m ago");
		expect(formatAgeAgo(7200)).toBe("fetched 2h ago");
		expect(formatAgeAgo(172800)).toBe("fetched 2d ago");
	});
});
