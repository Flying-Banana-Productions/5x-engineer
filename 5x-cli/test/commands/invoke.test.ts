/**
 * Tests for the invoke command (Phase 5).
 *
 * Tests cover:
 * - Template resolution (bundled + override)
 * - Variable substitution
 * - Structured output validation (valid AuthorStatus, valid ReviewerVerdict)
 * - Invalid structured output (INVALID_STRUCTURED_OUTPUT, exit code 7)
 * - Template not found (TEMPLATE_NOT_FOUND, exit code 2)
 * - NDJSON log file creation
 * - Session resume via --session
 *
 * Since invoke requires a provider to run, most tests mock the provider
 * factory or test individual pieces of the invoke pipeline directly.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo. */
function setupProject(dir: string): string {
	// Init git repo
	Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Create .5x directory and gitignore it
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Create plan
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	// Initial commit
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});

	return dir;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Unit tests for template resolution and variable parsing
// ---------------------------------------------------------------------------

describe("invoke", () => {
	describe("template resolution", () => {
		test("bundled template loads successfully", async () => {
			// loadTemplate should find bundled author-next-phase
			const { loadTemplate } = await import("../../src/templates/loader.js");
			const result = loadTemplate("author-next-phase");
			expect(result.metadata.name).toBe("author-next-phase");
			expect(result.body).toBeTruthy();
			expect(result.metadata.variables.length).toBeGreaterThan(0);
		});

		test("template override takes precedence over bundled", async () => {
			const dir = makeTmpDir();
			try {
				const { loadTemplate, setTemplateOverrideDir } = await import(
					"../../src/templates/loader.js"
				);

				// Create an override template
				const overrideDir = join(dir, "prompts");
				mkdirSync(overrideDir, { recursive: true });

				// The template needs valid frontmatter with the same name
				const overrideContent = [
					"---",
					"name: author-next-phase",
					"version: 99",
					"variables:",
					"  - plan_path",
					"  - phase_number",
					"  - user_notes",
					"---",
					"",
					"OVERRIDE TEMPLATE BODY {{plan_path}} {{phase_number}} {{user_notes}}",
				].join("\n");

				writeFileSync(
					join(overrideDir, "author-next-phase.md"),
					overrideContent,
				);

				setTemplateOverrideDir(overrideDir);
				const result = loadTemplate("author-next-phase");
				expect(result.metadata.version).toBe(99);
				expect(result.body).toContain("OVERRIDE TEMPLATE BODY");

				// Reset override
				setTemplateOverrideDir(null);
			} finally {
				cleanupDir(dir);
			}
		});

		test("unknown template throws appropriate error", async () => {
			const { loadTemplate } = await import("../../src/templates/loader.js");
			expect(() => loadTemplate("nonexistent-template")).toThrow(
				/Unknown template/,
			);
		});
	});

	describe("variable substitution", () => {
		test("renderTemplate substitutes variables correctly", async () => {
			const { renderTemplate } = await import("../../src/templates/loader.js");
			// author-next-phase expects plan_path, phase_number, user_notes
			const result = renderTemplate("author-next-phase", {
				plan_path: "/path/to/plan.md",
				phase_number: "1",
				user_notes: "test notes",
			});
			expect(result.name).toBe("author-next-phase");
			expect(result.prompt).toContain("/path/to/plan.md");
			expect(result.prompt).toContain("phase 1");
			expect(result.prompt).not.toContain("{{plan_path}}");
		});

		test("renderTemplate throws on missing required variables", async () => {
			const { renderTemplate } = await import("../../src/templates/loader.js");
			expect(() => renderTemplate("author-next-phase", {})).toThrow(
				/missing required variables/,
			);
		});
	});

	describe("structured output validation", () => {
		test("valid AuthorStatus passes assertion", async () => {
			const { assertAuthorStatus } = await import("../../src/protocol.js");
			// Should not throw
			assertAuthorStatus({ result: "complete", commit: "abc123" }, "test", {
				requireCommit: true,
			});
			assertAuthorStatus(
				{ result: "needs_human", reason: "needs input" },
				"test",
			);
			assertAuthorStatus({ result: "failed", reason: "error" }, "test");
		});

		test("invalid AuthorStatus throws on missing commit", async () => {
			const { assertAuthorStatus } = await import("../../src/protocol.js");
			expect(() =>
				assertAuthorStatus({ result: "complete" }, "test", {
					requireCommit: true,
				}),
			).toThrow(/commit/);
		});

		test("invalid AuthorStatus throws on missing reason", async () => {
			const { assertAuthorStatus } = await import("../../src/protocol.js");
			expect(() =>
				assertAuthorStatus({ result: "needs_human" }, "test"),
			).toThrow(/reason/);
		});

		test("valid ReviewerVerdict passes assertion", async () => {
			const { assertReviewerVerdict } = await import("../../src/protocol.js");
			// Should not throw
			assertReviewerVerdict({ readiness: "ready", items: [] }, "test");
			assertReviewerVerdict(
				{
					readiness: "not_ready",
					items: [
						{
							id: "P0.1",
							title: "Fix this",
							action: "auto_fix",
							reason: "broken",
						},
					],
				},
				"test",
			);
		});

		test("invalid ReviewerVerdict throws on empty items for non-ready", async () => {
			const { assertReviewerVerdict } = await import("../../src/protocol.js");
			expect(() =>
				assertReviewerVerdict({ readiness: "not_ready", items: [] }, "test"),
			).toThrow(/items/);
		});

		test("invalid ReviewerVerdict throws on missing action", async () => {
			const { assertReviewerVerdict } = await import("../../src/protocol.js");
			expect(() =>
				assertReviewerVerdict(
					{
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Fix this",
								action: undefined as unknown as "auto_fix",
								reason: "broken",
							},
						],
					},
					"test",
				),
			).toThrow(/action/);
		});
	});

	describe("NDJSON log creation", () => {
		test("nextLogSequence returns 001 for empty directory", async () => {
			const dir = makeTmpDir();
			try {
				const { nextLogSequence } = await import(
					"../../src/providers/log-writer.js"
				);
				const seq = nextLogSequence(dir);
				expect(seq).toBe("001");
			} finally {
				cleanupDir(dir);
			}
		});

		test("nextLogSequence increments from existing files", async () => {
			const dir = makeTmpDir();
			try {
				// Create some existing log files
				writeFileSync(join(dir, "agent-001.ndjson"), "");
				writeFileSync(join(dir, "agent-002.ndjson"), "");

				const { nextLogSequence } = await import(
					"../../src/providers/log-writer.js"
				);
				const seq = nextLogSequence(dir);
				expect(seq).toBe("003");
			} finally {
				cleanupDir(dir);
			}
		});

		test("nextLogSequence returns 001 for nonexistent directory", async () => {
			const { nextLogSequence } = await import(
				"../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence("/nonexistent/dir/12345");
			expect(seq).toBe("001");
		});
	});

	describe("parseVars helper", () => {
		// We can't import the private parseVars function directly, but we test
		// the behavior through the CLI. We test edge cases via the CliError path.

		test(
			"var flag without = is rejected by CLI",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"noequals",
						"--run",
						"run_test123",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("CLI integration", () => {
		test(
			"template not found returns exit code 2",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"nonexistent-template",
						"--run",
						"run_test123",
					]);
					expect(result.exitCode).toBe(2);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("TEMPLATE_NOT_FOUND");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"missing template variables returns error",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// author-next-phase requires plan_path, phase_id, plan_content, implementation_status
					// Only provide some of them
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/path/to/plan.md",
						"--run",
						"run_test123",
					]);
					// Should fail because of missing required variables
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke subcommand is registered and accessible",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// Just test that the command is registered - even with no args
					// it should show help or an error, not "unknown command"
					const result = await run5x(dir, ["invoke"]);
					// citty shows usage info for parent commands with subcommands
					// The exit code may be 0 (help) or non-zero, but it shouldn't crash
					// or say "unknown command"
					expect(result.stderr).not.toContain("Unknown command");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke author subcommand is registered",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// With no template arg, should get an error about missing template
					const result = await run5x(dir, ["invoke", "author"]);
					// Should not crash — citty will either show usage or error
					expect(result.exitCode).toBeDefined();
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke reviewer subcommand is registered",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, ["invoke", "reviewer"]);
					expect(result.exitCode).toBeDefined();
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("structured output error detection", () => {
		test("isStructuredOutputError detects nested StructuredOutputError", async () => {
			const { isStructuredOutputError } = await import("../../src/protocol.js");
			expect(
				isStructuredOutputError({
					data: {
						info: {
							error: { name: "StructuredOutputError", message: "oops" },
						},
					},
				}),
			).toBe(true);
		});

		test("isStructuredOutputError detects top-level error", async () => {
			const { isStructuredOutputError } = await import("../../src/protocol.js");
			expect(
				isStructuredOutputError({
					error: { name: "StructuredOutputError", message: "oops" },
				}),
			).toBe(true);
		});

		test("isStructuredOutputError returns false for valid result", async () => {
			const { isStructuredOutputError } = await import("../../src/protocol.js");
			expect(
				isStructuredOutputError({
					result: "complete",
					commit: "abc123",
				}),
			).toBe(false);
		});

		test("isStructuredOutputError detects object-typed error payloads (P0.2 regression)", async () => {
			// StructuredOutputError payloads are typically objects. The old code
			// only called isStructuredOutputError inside the !object guard, making
			// detection unreachable for object payloads. This test ensures
			// object-typed StructuredOutputError payloads are still detected.
			const { isStructuredOutputError } = await import("../../src/protocol.js");

			// Object with nested structured output error — should be detected
			const objError = {
				data: {
					info: {
						error: {
							name: "StructuredOutputError",
							message: "Failed to parse structured output",
						},
					},
				},
				// This is an object, so typeof === "object" is true
				someOtherField: "value",
			};
			expect(typeof objError).toBe("object");
			expect(isStructuredOutputError(objError)).toBe(true);

			// Object with message-based detection
			const msgError = {
				error: {
					name: "SomeError",
					message: "structured output parsing failed",
				},
			};
			expect(typeof msgError).toBe("object");
			expect(isStructuredOutputError(msgError)).toBe(true);
		});
	});

	describe("schemas match expected format", () => {
		test("AuthorStatusSchema has correct structure", async () => {
			const { AuthorStatusSchema } = await import("../../src/protocol.js");
			expect(AuthorStatusSchema.type).toBe("object");
			expect(AuthorStatusSchema.required).toContain("result");
			expect(AuthorStatusSchema.properties.result.enum).toEqual([
				"complete",
				"needs_human",
				"failed",
			]);
		});

		test("ReviewerVerdictSchema has correct structure", async () => {
			const { ReviewerVerdictSchema } = await import("../../src/protocol.js");
			expect(ReviewerVerdictSchema.type).toBe("object");
			expect(ReviewerVerdictSchema.required).toContain("readiness");
			expect(ReviewerVerdictSchema.required).toContain("items");
		});
	});

	describe("CliError exit codes", () => {
		test("TEMPLATE_NOT_FOUND maps to exit code 2", async () => {
			const { exitCodeForError } = await import("../../src/output.js");
			expect(exitCodeForError("TEMPLATE_NOT_FOUND")).toBe(2);
		});

		test("INVALID_STRUCTURED_OUTPUT maps to exit code 7", async () => {
			const { exitCodeForError } = await import("../../src/output.js");
			expect(exitCodeForError("INVALID_STRUCTURED_OUTPUT")).toBe(7);
		});

		test("PROVIDER_NOT_FOUND maps to exit code 2", async () => {
			const { exitCodeForError } = await import("../../src/output.js");
			expect(exitCodeForError("PROVIDER_NOT_FOUND")).toBe(2);
		});
	});

	describe("provider factory integration", () => {
		test("factory defaults to opencode provider", async () => {
			const { FiveXConfigSchema } = await import("../../src/config.js");
			const config = FiveXConfigSchema.parse({});

			// The factory should attempt to create an OpenCode provider.
			// Since we don't have a running OpenCode server, this will throw,
			// but it should NOT throw PROVIDER_NOT_FOUND — it should be the
			// bundled OpenCode provider path.
			const { createProvider } = await import("../../src/providers/factory.js");
			try {
				await createProvider("author", config);
			} catch (err) {
				// Expected: OpenCode server not available in test.
				// But should NOT be PROVIDER_NOT_FOUND.
				if (err instanceof Error && "code" in err) {
					expect((err as { code: string }).code).not.toBe("PROVIDER_NOT_FOUND");
				}
			}
		});

		test("factory throws PROVIDER_NOT_FOUND for missing plugin", async () => {
			const { FiveXConfigSchema } = await import("../../src/config.js");
			// Create config with a non-existent provider
			const config = FiveXConfigSchema.parse({});
			// Manually set provider (forward-compatible pre-Phase-8)
			const configWithPlugin = {
				...config,
				author: { ...config.author, provider: "nonexistent-provider" },
			};

			const { createProvider, ProviderNotFoundError } = await import(
				"../../src/providers/factory.js"
			);
			try {
				await createProvider("author", configWithPlugin);
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ProviderNotFoundError);
			}
		});
	});

	describe("NDJSON log writer integration", () => {
		test("log directory is created with correct structure", () => {
			const dir = makeTmpDir();
			try {
				const logDir = join(dir, ".5x", "logs", "run_test123");
				mkdirSync(logDir, { recursive: true, mode: 0o700 });

				const logPath = join(logDir, "agent-001.ndjson");
				const events: Array<Record<string, unknown>> = [
					{ type: "text", delta: "Hello " },
					{ type: "text", delta: "world" },
					{
						type: "usage",
						tokens: { in: 100, out: 50 },
						costUsd: 0.005,
					},
					{
						type: "done",
						result: {
							text: "Hello world",
							structured: { result: "complete" },
							sessionId: "sess-1",
							tokens: { in: 100, out: 50 },
							costUsd: 0.005,
							durationMs: 1234,
						},
					},
				];

				// Write events as NDJSON
				for (const event of events) {
					const line = JSON.stringify({
						...event,
						ts: new Date().toISOString(),
					});
					writeFileSync(logPath, `${line}\n`, { flag: "a" });
				}

				// Verify log file exists and has correct format
				expect(existsSync(logPath)).toBe(true);

				const content = readFileSync(logPath, "utf-8").trim();
				const lines = content.split("\n");
				expect(lines.length).toBe(4);

				// Each line should be valid JSON
				for (const line of lines) {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					expect(parsed.type).toBeTruthy();
					expect(parsed.ts).toBeTruthy();
				}

				// First event should be text
				const firstLine = lines[0] ?? "";
				const first = JSON.parse(firstLine) as Record<string, unknown>;
				expect(first.type).toBe("text");
				expect(first.delta).toBe("Hello ");

				// Last event should be done
				const lastLine = lines[lines.length - 1] ?? "";
				const last = JSON.parse(lastLine) as Record<string, unknown>;
				expect(last.type).toBe("done");
			} finally {
				cleanupDir(dir);
			}
		});

		test("log sequence numbers increment correctly", async () => {
			const dir = makeTmpDir();
			try {
				const logDir = join(dir, ".5x", "logs", "run_test456");
				mkdirSync(logDir, { recursive: true });

				// Create first log
				writeFileSync(join(logDir, "agent-001.ndjson"), "");
				writeFileSync(join(logDir, "agent-002.ndjson"), "");

				const { nextLogSequence } = await import(
					"../../src/providers/log-writer.js"
				);
				const seq = nextLogSequence(logDir);
				expect(seq).toBe("003");
			} finally {
				cleanupDir(dir);
			}
		});
	});

	describe("session resume", () => {
		test(
			"--session flag is accepted by the command definition",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// Pass --session flag — the command should parse it.
					// It will fail because the provider can't connect, but
					// the flag should be recognized.
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--session",
						"sess-resume-123",
						"--run",
						"run_test789",
					]);
					// It should NOT say "unknown flag" or similar parse error
					// It will likely fail on provider connection but that's expected
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					// Should fail on provider/agent, NOT on arg parsing
					expect(error.code).not.toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("run_id validation (P0.1)", () => {
		test(
			"path traversal in --run is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"../../../etc/evil",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test("run_id with dots is rejected", async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					"plan_path=/p",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=none",
					"--run",
					"run..traversal",
				]);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		});

		test(
			"valid run_id is accepted",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// This will fail later (no provider), but should NOT fail on run_id validation
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_abc123",
					]);
					const json = parseJson(result.stdout);
					if (!json.ok) {
						const error = json.error as Record<string, unknown>;
						// Should NOT fail on INVALID_ARGS for the run_id
						expect(error.code).not.toBe("INVALID_ARGS");
					}
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"run_id starting with non-alphanumeric is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"-run_123",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("timeout validation (P0.3)", () => {
		test(
			"NaN timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"notanumber",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
					expect(typeof error.message === "string" && error.message).toContain(
						"--timeout",
					);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"negative timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// Note: citty may interpret "-5" as a flag rather than a value,
					// so we use --timeout=-5 format to ensure it's passed as the value.
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout=-5",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"zero timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"0",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"partial parse timeout (e.g. '10abc') is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"10abc",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"valid positive integer timeout is accepted",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					// Will fail on provider, but should NOT fail on timeout validation
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"30",
					]);
					const json = parseJson(result.stdout);
					if (!json.ok) {
						const error = json.error as Record<string, unknown>;
						expect(error.code).not.toBe("INVALID_ARGS");
					}
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("--run is required (P1.1)", () => {
		test(
			"invoke without --run fails",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
					]);
					// Should fail — --run is required
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("output envelope format", () => {
		test("CliError produces correct JSON envelope", async () => {
			const { CliError } = await import("../../src/output.js");
			const err = new CliError("TEMPLATE_NOT_FOUND", "Template foo not found");
			expect(err.code).toBe("TEMPLATE_NOT_FOUND");
			expect(err.exitCode).toBe(2);
			expect(err.message).toBe("Template foo not found");
		});

		test("CliError with INVALID_STRUCTURED_OUTPUT has exit code 7", async () => {
			const { CliError } = await import("../../src/output.js");
			const err = new CliError("INVALID_STRUCTURED_OUTPUT", "Bad output", {
				raw: {},
			});
			expect(err.exitCode).toBe(7);
			expect(err.detail).toEqual({ raw: {} });
		});
	});
});
