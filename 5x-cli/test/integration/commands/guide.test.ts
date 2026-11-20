/**
 * Integration tests for `5x guide plan` — stdout contract and exit codes.
 *
 * Content is covered by test/unit/commands/guide.test.ts. These tests pin what
 * only the binary decides: markdown by default, an envelope when JSON is
 * requested, and no state created along the way.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeProject(): string {
	const dir = join(
		tmpdir(),
		`5x-guide-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(dir, "docs/plans"), { recursive: true });
	writeFileSync(join(dir, "5x.toml"), '[paths]\nplans = "docs/plans"\n');
	writeFileSync(join(dir, "tdd.md"), "# TDD\n");
	return dir;
}

async function run5x(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...cleanGitEnv(), FIVEX_OUTPUT_FORMAT: "", ...env },
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

describe("5x guide plan", () => {
	test(
		"prints raw markdown by default and creates no state",
		async () => {
			const dir = makeProject();
			try {
				const result = await run5x(dir, [
					"guide",
					"plan",
					"tdd.md",
					"--out",
					"docs/plans/a.md",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout.startsWith("You are implementing")).toBe(true);
				expect(result.stdout).toContain("## Standalone Authoring");
				expect(result.stdout).toContain(
					"5x plan phases docs/plans/a.md | jq '.data | {executability, budget}'",
				);
				expect(result.stdout.endsWith("\n")).toBe(true);
				expect(existsSync(join(dir, ".5x"))).toBe(false);
				expect(existsSync(join(dir, "docs/plans/a.md"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns an envelope when JSON is requested by flag or environment",
		async () => {
			const dir = makeProject();
			try {
				const [flag, env] = await Promise.all([
					run5x(dir, ["guide", "plan", "tdd.md", "--json"]),
					run5x(dir, ["guide", "plan", "tdd.md"], {
						FIVEX_OUTPUT_FORMAT: "json",
					}),
				]);
				for (const result of [flag, env]) {
					expect(result.exitCode).toBe(0);
					const envelope = JSON.parse(result.stdout);
					expect(envelope.ok).toBe(true);
					expect(envelope.data.guide).toBe("plan");
					expect(envelope.data.prompt).toContain("## Standalone Authoring");
					expect(envelope.data.plan_path).toBeNull();
					expect(envelope.data.plan_template_inlined).toBe(true);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"fails with exit 2 when the requirements document is missing",
		async () => {
			const dir = makeProject();
			try {
				const result = await run5x(dir, ["guide", "plan", "nope.md"]);
				expect(result.exitCode).toBe(2);
				expect(JSON.parse(result.stdout).error.code).toBe("SOURCE_NOT_FOUND");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
