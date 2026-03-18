import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

async function run5x(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: cleanGitEnv(),
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x template list", () => {
	test("returns JSON envelope with all templates", async () => {
		const { stdout, exitCode } = await run5x(["template", "list"]);
		expect(exitCode).toBe(0);

		const envelope = JSON.parse(stdout);
		expect(envelope.ok).toBe(true);
		expect(Array.isArray(envelope.data.templates)).toBe(true);
		expect(envelope.data.templates.length).toBeGreaterThan(0);

		// Check shape of each item
		for (const t of envelope.data.templates) {
			expect(typeof t.name).toBe("string");
			expect(typeof t.source).toBe("string");
			expect(["bundled", "override"]).toContain(t.source);
		}

		// Known templates should be present
		const names = envelope.data.templates.map((t: { name: string }) => t.name);
		expect(names).toContain("author-next-phase");
		expect(names).toContain("reviewer-plan");
		expect(names).toContain("reviewer-commit");
	});

	test("text mode outputs readable list", async () => {
		const { stdout, exitCode } = await run5x(["template", "list", "--text"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("author-next-phase");
		expect(stdout).toContain("reviewer-plan");
	});
});

describe("5x template describe", () => {
	test("returns JSON envelope with template metadata", async () => {
		const { stdout, exitCode } = await run5x([
			"template",
			"describe",
			"author-next-phase",
		]);
		expect(exitCode).toBe(0);

		const envelope = JSON.parse(stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.name).toBe("author-next-phase");
		expect(envelope.data.version).toBe(1);
		expect(envelope.data.step_name).toBe("author:implement");
		expect(envelope.data.source).toBe("bundled");
		expect(Array.isArray(envelope.data.variables)).toBe(true);
		expect(envelope.data.variables).toContain("plan_path");
		expect(envelope.data.variables).toContain("phase_number");
		expect(typeof envelope.data.description).toBe("string");
		expect(typeof envelope.data.variable_defaults).toBe("object");
	});

	test("text mode outputs labeled fields", async () => {
		const { stdout, exitCode } = await run5x([
			"template",
			"describe",
			"author-next-phase",
			"--text",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Name:");
		expect(stdout).toContain("author-next-phase");
		expect(stdout).toContain("Version:");
		expect(stdout).toContain("Step name:");
		expect(stdout).toContain("Variables:");
		expect(stdout).toContain("plan_path");
	});

	test("errors for unknown template name", async () => {
		const { stdout, exitCode } = await run5x([
			"template",
			"describe",
			"nonexistent-template",
		]);
		expect(exitCode).not.toBe(0);

		const envelope = JSON.parse(stdout);
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("TEMPLATE_NOT_FOUND");
	});
});
