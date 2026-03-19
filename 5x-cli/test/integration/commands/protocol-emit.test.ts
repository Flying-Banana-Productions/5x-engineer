/**
 * Integration tests for `5x protocol emit` command.
 *
 * Spawns the CLI binary and validates stdout/stderr/exit code behavior.
 * Verifies the raw-JSON-on-success / envelope-on-error contract.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	args: string[],
	opts?: { stdin?: string; timeoutMs?: number },
): Promise<CmdResult> {
	const useStdin = opts?.stdin !== undefined;
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		env: cleanGitEnv(),
		stdin: useStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (useStdin && proc.stdin) {
		proc.stdin.write(opts?.stdin ?? "");
		proc.stdin.end();
	}
	const timer = setTimeout(() => proc.kill("SIGINT"), opts?.timeoutMs ?? 15000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Reviewer emit
// ---------------------------------------------------------------------------

describe("5x protocol emit reviewer (integration)", () => {
	test(
		"e2e: --ready emits raw canonical JSON (not envelope)",
		async () => {
			const result = await run5x(["protocol", "emit", "reviewer", "--ready"]);

			expect(result.exitCode).toBe(0);

			// Must be raw JSON, NOT wrapped in { ok: true, data: ... }
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.ok).toBeUndefined();
			expect(parsed.readiness).toBe("ready");
			expect(parsed.items).toEqual([]);
		},
		{ timeout: 15000 },
	);

	test(
		"e2e: --no-ready with --item produces valid verdict",
		async () => {
			const result = await run5x([
				"protocol",
				"emit",
				"reviewer",
				"--no-ready",
				"--item",
				'{"title":"Fix bug","action":"auto_fix","reason":"Off by one"}',
				"--summary",
				"Needs fixes",
			]);

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.readiness).toBe("not_ready");
			expect(parsed.summary).toBe("Needs fixes");
			const items = parsed.items as Array<Record<string, unknown>>;
			expect(items).toHaveLength(1);
			expect(items[0]?.title).toBe("Fix bug");
			expect(items[0]?.id).toBe("R1");
		},
		{ timeout: 15000 },
	);

	test(
		"e2e: stdin normalization — pipe non-conforming JSON, get canonical output",
		async () => {
			const input = JSON.stringify({
				verdict: "conditionally_approved",
				issues: [
					{
						title: "Fix import",
						severity: "minor",
						reason: "Unused",
					},
				],
			});

			const result = await run5x(["protocol", "emit", "reviewer"], {
				stdin: input,
			});

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.readiness).toBe("ready_with_corrections");
			const items = parsed.items as Array<Record<string, unknown>>;
			expect(items[0]?.priority).toBe("P2");
			expect(items[0]?.id).toBe("R1");
			expect(items[0]?.action).toBe("human_required");
			// No envelope
			expect(parsed.ok).toBeUndefined();
		},
		{ timeout: 15000 },
	);

	test(
		"e2e: output passes 5x protocol validate reviewer",
		async () => {
			// First emit
			const emitResult = await run5x([
				"protocol",
				"emit",
				"reviewer",
				"--ready",
				"--item",
				'{"title":"Fix X","action":"auto_fix","reason":"Y"}',
			]);
			expect(emitResult.exitCode).toBe(0);

			// Then validate
			const validateResult = await run5x(["protocol", "validate", "reviewer"], {
				stdin: emitResult.stdout,
			});
			expect(validateResult.exitCode).toBe(0);
			const parsed = JSON.parse(validateResult.stdout) as Record<
				string,
				unknown
			>;
			expect(parsed.ok).toBe(true);
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Author emit
// ---------------------------------------------------------------------------

describe("5x protocol emit author (integration)", () => {
	test(
		"e2e: --complete --commit emits raw JSON",
		async () => {
			const result = await run5x([
				"protocol",
				"emit",
				"author",
				"--complete",
				"--commit",
				"abc123def",
			]);

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.ok).toBeUndefined();
			expect(parsed.result).toBe("complete");
			expect(parsed.commit).toBe("abc123def");
		},
		{ timeout: 15000 },
	);

	test(
		"e2e: stdin normalization for author",
		async () => {
			const input = JSON.stringify({
				status: "done",
				commit: "xyz789",
			});

			const result = await run5x(["protocol", "emit", "author"], {
				stdin: input,
			});

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.result).toBe("complete");
			expect(parsed.commit).toBe("xyz789");
			expect(parsed.ok).toBeUndefined();
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("5x protocol emit — error cases (integration)", () => {
	test(
		"missing required flags → non-zero exit + error envelope",
		async () => {
			// No --ready/--no-ready and no stdin
			const result = await run5x(["protocol", "emit", "reviewer"]);

			expect(result.exitCode).not.toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.ok).toBe(false);
			const error = parsed.error as Record<string, unknown>;
			expect(error.code).toBe("INVALID_ARGS");
			expect(error.message).toBeDefined();
		},
		{ timeout: 15000 },
	);

	test(
		"--complete without --commit → succeeds (commit is optional)",
		async () => {
			const result = await run5x(["protocol", "emit", "author", "--complete"]);

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as { result: string };
			expect(parsed.result).toBe("complete");
		},
		{ timeout: 15000 },
	);

	test(
		"multiple result flags → non-zero exit + error envelope",
		async () => {
			const result = await run5x([
				"protocol",
				"emit",
				"author",
				"--complete",
				"--failed",
				"--commit",
				"abc",
			]);

			expect(result.exitCode).not.toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.ok).toBe(false);
		},
		{ timeout: 15000 },
	);
});
