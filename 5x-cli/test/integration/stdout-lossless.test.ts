/**
 * Integration test for lossless CLI stdout: output larger than the pipe
 * buffer must reach a slow piped reader intact, even when the process exits
 * via `process.exit()` right after printing.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const HELPER = resolve(import.meta.dir, "../helpers/large-stdout-helper.ts");
const BYTES = 300_000;

async function runHelper(
	mode: "lossless" | "raw",
): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", HELPER, String(BYTES), mode], {
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// Let the writer fill the pipe (and try to exit) before anything is read.
	await Bun.sleep(500);
	const [stdout, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { stdout, exitCode };
}

describe("lossless stdout", () => {
	test(
		"delivers output larger than the pipe buffer to a slow reader",
		async () => {
			const { stdout, exitCode } = await runHelper("lossless");
			expect(exitCode).toBe(3);
			expect(stdout.length).toBe(BYTES + 1 + "tail\n".length);
			expect(stdout.endsWith("x\ntail\n")).toBe(true);
		},
		{ timeout: 15000 },
	);
});
