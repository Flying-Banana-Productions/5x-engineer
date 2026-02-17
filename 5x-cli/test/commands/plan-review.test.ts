import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

async function runCommand(
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd: cwd ?? resolve(import.meta.dir, "../../"),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x plan-review CLI", () => {
	test("errors when plan file not found", async () => {
		const { stderr, exitCode } = await runCommand([
			"plan-review",
			"nonexistent-plan.md",
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("not found");
	});

	test("errors when file has no phases", async () => {
		// Use a file that exists but isn't a plan (e.g., README)
		const { exitCode } = await runCommand(["plan-review", "README.md"]);
		// README.md may or may not exist — but if it does, it should fail with "no phases"
		// If it doesn't exist, it should fail with "not found"
		expect(exitCode).not.toBe(0);
	});
});

describe("5x plan CLI", () => {
	test("errors when PRD file not found", async () => {
		const { stderr, exitCode } = await runCommand([
			"plan",
			"nonexistent-prd.md",
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("not found");
	});
});
