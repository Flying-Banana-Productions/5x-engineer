import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const runLiveAgentTests = process.env.FIVE_X_TEST_LIVE_AGENTS === "1";
const liveTest = runLiveAgentTests ? test : test.skip;

describe("OpenCode SDK compile smoke (env-gated)", () => {
	let tempDir: string | null = null;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	liveTest("imports SDK and constructs client in compiled binary", () => {
		tempDir = mkdtempSync(join(tmpdir(), "5x-opencode-compile-"));
		const entryPath = join(tempDir, "smoke.ts");
		const outputPath = join(tempDir, "smoke-bin");

		writeFileSync(
			entryPath,
			[
				'import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";',
				"",
				"const client = createOpencodeClient();",
				'if (!client || typeof client !== "object") {',
				'  throw new Error("Failed to construct OpenCode client");',
				"}",
				"",
				"void createOpencode;",
				'console.log("ok");',
			].join("\n"),
		);

		const build = Bun.spawnSync(
			["bun", "build", "--compile", entryPath, "--outfile", outputPath],
			{
				cwd: PROJECT_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		expect(
			build.exitCode,
			`bun build --compile failed: ${build.stderr.toString()}`,
		).toBe(0);

		const run = Bun.spawnSync([outputPath], {
			cwd: PROJECT_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(
			run.exitCode,
			`compiled smoke binary failed: ${run.stderr.toString()}`,
		).toBe(0);
		expect(run.stdout.toString().trim()).toBe("ok");
	});
});
