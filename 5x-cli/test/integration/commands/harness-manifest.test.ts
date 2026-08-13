/**
 * Integration tests for the harness asset manifest — CLI round-trips.
 *
 * Phase 3 (201-harness-freshness). Filesystem-level assertions that need no
 * CLI layer live in test/unit/commands/harness.test.ts; these cover the
 * end-to-end command sequence and the stdout/stderr the user actually sees.
 *
 * The headline case is the review §1 regression: after `author.model` changes,
 * a plain (non-force) `5x harness install` refreshes skills but preserves
 * agent files, so the manifest must NOT adopt the new inputs as a baseline.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type HarnessManifest,
	MANIFEST_FILENAME,
} from "../../../src/harnesses/manifest.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function readOpencodeManifest(projectDir: string): HarnessManifest {
	const raw = readFileSync(
		join(projectDir, ".opencode", MANIFEST_FILENAME),
		"utf-8",
	);
	return JSON.parse(raw) as HarnessManifest;
}

function readPlanAuthorAgent(projectDir: string): string {
	return readFileSync(
		join(projectDir, ".opencode", "agents", "5x-plan-author.md"),
		"utf-8",
	);
}

// ---------------------------------------------------------------------------
// Install writes a manifest
// ---------------------------------------------------------------------------

describe("5x harness install manifest", () => {
	test(
		"writes a verified manifest and reports it on stdout",
		async () => {
			const tmp = makeTmpDir();
			try {
				expect((await run5x(tmp, ["init"])).exitCode).toBe(0);

				const install = await run5x(tmp, [
					"harness",
					"install",
					"opencode",
					"--scope",
					"project",
				]);
				expect(install.exitCode).toBe(0);
				expect(install.stdout).toContain(
					`Wrote manifest: ${MANIFEST_FILENAME}`,
				);

				const manifest = readOpencodeManifest(tmp);
				expect(manifest.harness).toBe("opencode");
				expect(manifest.scope).toBe("project");
				expect(manifest.baseline).toBe("verified");
				expect(manifest.configResolved).toBe(true);
				expect(manifest.assets.length).toBeGreaterThan(0);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 60000 },
	);
});

// ---------------------------------------------------------------------------
// Review §1 regression — a plain reinstall must never claim a baseline
// ---------------------------------------------------------------------------

describe("no false-fresh via plain reinstall", () => {
	test(
		"model change + non-force reinstall leaves an unverified baseline with the prior inputs",
		async () => {
			const tmp = makeTmpDir();
			try {
				expect((await run5x(tmp, ["init"])).exitCode).toBe(0);
				expect(
					(await run5x(tmp, ["config", "set", "author.model", "model/A"]))
						.exitCode,
				).toBe(0);

				expect(
					(
						await run5x(tmp, [
							"harness",
							"install",
							"opencode",
							"--scope",
							"project",
						])
					).exitCode,
				).toBe(0);
				expect(readPlanAuthorAgent(tmp)).toContain("model/A");
				const baselined = readOpencodeManifest(tmp);
				expect(baselined.baseline).toBe("verified");
				expect(baselined.inputs.authorModel).toBe("model/A");

				// Change the baked input at the point of cause.
				expect(
					(await run5x(tmp, ["config", "set", "author.model", "model/B"]))
						.exitCode,
				).toBe(0);

				// The folk remedy: reinstall without --force.
				const reinstall = await run5x(tmp, [
					"harness",
					"install",
					"opencode",
					"--scope",
					"project",
				]);
				expect(reinstall.exitCode).toBe(0);

				// The agent file is still baked from model/A — install preserves it.
				expect(readPlanAuthorAgent(tmp)).toContain("model/A");
				expect(readPlanAuthorAgent(tmp)).not.toContain("model/B");

				// So the manifest must not adopt model/B as the baseline.
				const partial = readOpencodeManifest(tmp);
				expect(partial.baseline).toBe("unverified");
				expect(partial.inputs.authorModel).toBe("model/A");
				expect(partial.hash).toBe(baselined.hash);

				// And the user is told why, on stderr, with the fix.
				expect(reinstall.stderr).toContain(
					"freshness baseline not established",
				);
				expect(reinstall.stderr).toContain("5x harness sync");
				expect(reinstall.stderr).toContain("agents/5x-plan-author.md");

				// `--force` is the one-step escape hatch until `harness sync` lands
				// (Phase 6): it rewrites every managed asset, so it verifies.
				const forced = await run5x(tmp, [
					"harness",
					"install",
					"opencode",
					"--scope",
					"project",
					"--force",
				]);
				expect(forced.exitCode).toBe(0);
				expect(forced.stderr).not.toContain(
					"freshness baseline not established",
				);
				expect(readPlanAuthorAgent(tmp)).toContain("model/B");

				const rebaselined = readOpencodeManifest(tmp);
				expect(rebaselined.baseline).toBe("verified");
				expect(rebaselined.inputs.authorModel).toBe("model/B");
				expect(rebaselined.hash).not.toBe(baselined.hash);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// Uninstall removes the manifest before the emptiness sweep
// ---------------------------------------------------------------------------

describe("5x harness uninstall manifest", () => {
	test(
		"--all removes the manifest and leaves no orphan install root",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });
			try {
				expect((await run5x(tmp, ["init"])).exitCode).toBe(0);
				expect(
					(
						await run5x(tmp, [
							"harness",
							"install",
							"opencode",
							"--scope",
							"project",
						])
					).exitCode,
				).toBe(0);
				expect(existsSync(join(tmp, ".opencode", MANIFEST_FILENAME))).toBe(
					true,
				);

				const uninstall = await run5x(tmp, [
					"harness",
					"uninstall",
					"opencode",
					"--scope",
					"project",
				]);
				expect(uninstall.exitCode).toBe(0);

				const envelope = JSON.parse(uninstall.stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data.manifests.project).toBe(true);
				expect(existsSync(join(tmp, ".opencode"))).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 60000 },
	);
});
