/**
 * Real-git regression for records-root dirty-tree exemption.
 *
 * Unit tests mock `execGit` and can hide trailing-newline / path-join
 * mismatches. This suite creates a temporary repository and calls
 * `checkGitSafety` without mocks.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGitSafety } from "../../src/git.js";
import { realpathExisting } from "../../src/paths.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-git-safety-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

function setupRepo(dir: string): string {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "README.md"), "# repo\n");
	git(["add", "README.md"], dir);
	git(["commit", "-m", "init"], dir);
	return realpathExisting(dir);
}

describe("checkGitSafety records-root exemption (real git)", () => {
	test(
		"uncommitted records-root files are exempt; mixed dirty paths are not",
		async () => {
			const dir = makeTmpDir();
			try {
				const repoRoot = setupRepo(dir);
				const recordsRoot = join(repoRoot, "docs", "development", "runs");
				mkdirSync(join(recordsRoot, "p", "r"), { recursive: true });
				writeFileSync(join(recordsRoot, "p", "r", "steps.jsonl"), "{}\n");

				const rawToplevel = Bun.spawnSync(
					["git", "rev-parse", "--show-toplevel"],
					{
						cwd: repoRoot,
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				).stdout.toString();
				expect(rawToplevel.endsWith("\n")).toBe(true);

				const recordsOnly = await checkGitSafety(repoRoot, {
					exemptRoots: [recordsRoot],
				});
				expect(recordsOnly.safe).toBe(true);
				expect(recordsOnly.isDirty).toBe(false);
				expect(recordsOnly.untrackedFiles).toEqual([]);
				expect(recordsOnly.repoRoot).toBe(rawToplevel.trim());
				expect(realpathExisting(recordsOnly.repoRoot)).toBe(repoRoot);

				writeFileSync(join(repoRoot, "extra.txt"), "dirty\n");
				const mixed = await checkGitSafety(repoRoot, {
					exemptRoots: [recordsRoot],
				});
				expect(mixed.safe).toBe(false);
				expect(mixed.isDirty).toBe(true);
				expect(mixed.untrackedFiles).toEqual(["extra.txt"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
