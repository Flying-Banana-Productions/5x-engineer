import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type QualityGateOptions,
	runQualityGates,
	runSingleCommand,
} from "../../src/gates/quality.js";

// ---------------------------------------------------------------------------
// Helpers — each test creates its own tmp dir for isolation
// ---------------------------------------------------------------------------

function makeTmp(): string {
	const tmp = mkdtempSync(join(tmpdir(), "5x-qg-"));
	mkdirSync(join(tmp, ".5x", "logs", "run"), { recursive: true });
	return tmp;
}

function makeOpts(
	tmp: string,
	overrides?: Partial<QualityGateOptions>,
): QualityGateOptions {
	return {
		runId: "run",
		logDir: join(tmp, ".5x", "logs", "run"),
		phase: "1",
		attempt: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSingleCommand", () => {
	test("successful command returns passed=true", async () => {
		const tmp = makeTmp();
		try {
			const result = await runSingleCommand("echo hello", tmp, makeOpts(tmp));

			expect(result.passed).toBe(true);
			expect(result.command).toBe("echo hello");
			expect(result.output).toContain("hello");
			expect(result.duration).toBeGreaterThan(0);
			expect(result.outputPath).toBeDefined();

			const logContent = readFileSync(result.outputPath ?? "", "utf-8");
			expect(logContent).toContain("hello");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("failing command returns passed=false", async () => {
		const tmp = makeTmp();
		try {
			const result = await runSingleCommand("exit 1", tmp, makeOpts(tmp));
			expect(result.passed).toBe(false);
			expect(result.command).toBe("exit 1");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("captures stderr", async () => {
		const tmp = makeTmp();
		try {
			const result = await runSingleCommand(
				"echo err >&2 && exit 1",
				tmp,
				makeOpts(tmp),
			);
			expect(result.passed).toBe(false);
			expect(result.output).toContain("err");
			expect(result.output).toContain("stderr");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("timeout kills long-running command", async () => {
		const tmp = makeTmp();
		try {
			const result = await runSingleCommand(
				"sleep 60",
				tmp,
				makeOpts(tmp, { timeout: 0 }),
			);
			expect(result.passed).toBe(false);
			expect(result.output).toContain("TIMEOUT");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("generates log file with correct name pattern", async () => {
		const tmp = makeTmp();
		try {
			await runSingleCommand(
				"echo test",
				tmp,
				makeOpts(tmp, { phase: "2", attempt: 1 }),
			);
			const logDir = join(tmp, ".5x", "logs", "run");
			expect(
				existsSync(join(logDir, "quality-phase2-attempt1-echo-test.log")),
			).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("truncates large output in result but preserves full log", async () => {
		const tmp = makeTmp();
		try {
			const result = await runSingleCommand(
				"python3 -c \"print('x' * 8192)\" || printf '%0.sx' $(seq 1 8192)",
				tmp,
				makeOpts(tmp),
			);

			if (result.passed) {
				const logContent = readFileSync(result.outputPath ?? "", "utf-8");
				expect(logContent.length).toBeGreaterThan(4096);
				expect(result.output.length).toBeLessThan(logContent.length);
				expect(result.output).toContain("truncated");
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("runQualityGates", () => {
	test("all passing commands returns passed=true", async () => {
		const tmp = makeTmp();
		try {
			const result = await runQualityGates(
				["echo step1", "echo step2"],
				tmp,
				makeOpts(tmp),
			);
			expect(result.passed).toBe(true);
			expect(result.results).toHaveLength(2);
			expect(result.results[0]?.passed).toBe(true);
			expect(result.results[1]?.passed).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("one failing command makes overall fail", async () => {
		const tmp = makeTmp();
		try {
			const result = await runQualityGates(
				["echo ok", "exit 1", "echo after"],
				tmp,
				makeOpts(tmp),
			);
			expect(result.passed).toBe(false);
			expect(result.results).toHaveLength(3);
			expect(result.results[0]?.passed).toBe(true);
			expect(result.results[1]?.passed).toBe(false);
			expect(result.results[2]?.passed).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("empty commands list returns passed=true", async () => {
		const tmp = makeTmp();
		try {
			const result = await runQualityGates([], tmp, makeOpts(tmp));
			expect(result.passed).toBe(true);
			expect(result.results).toHaveLength(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("creates log directory if missing", async () => {
		const tmp = makeTmp();
		try {
			const customLogDir = join(tmp, "custom", "nested", "logs");
			const result = await runQualityGates(
				["echo hello"],
				tmp,
				makeOpts(tmp, { logDir: customLogDir }),
			);
			expect(result.passed).toBe(true);
			expect(existsSync(customLogDir)).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("runs commands in correct workdir", async () => {
		const tmp = makeTmp();
		try {
			const subdir = join(tmp, "sub");
			mkdirSync(subdir);
			const result = await runQualityGates(["pwd"], subdir, makeOpts(tmp));
			expect(result.passed).toBe(true);
			expect(result.results[0]?.output).toContain("sub");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
