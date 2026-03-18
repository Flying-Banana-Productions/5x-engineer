/**
 * Unit tests for invoke command internals.
 *
 * Tests cover pure functions called by the invoke handler — no subprocesses.
 * Template resolution, variable substitution, structured output validation,
 * NDJSON log helpers, schema contracts, exit codes, provider factory routing.
 *
 * CLI-level tests (exit codes from subprocess, arg parsing, stderr streaming)
 * remain in test/integration/commands/invoke.test.ts.
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
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { invokeAgent } from "../../../src/commands/invoke.handler.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

// ===========================================================================
// Template resolution
// ===========================================================================

describe("invoke — template resolution (unit)", () => {
	test("bundled template loads successfully", async () => {
		const { loadTemplate } = await import("../../../src/templates/loader.js");
		const result = loadTemplate("author-next-phase");
		expect(result.metadata.name).toBe("author-next-phase");
		expect(result.body).toBeTruthy();
		expect(result.metadata.variables.length).toBeGreaterThan(0);
	});

	test("template override takes precedence over bundled", async () => {
		const dir = makeTmpDir();
		try {
			const { loadTemplate, setTemplateOverrideDir } = await import(
				"../../../src/templates/loader.js"
			);

			const overrideDir = join(dir, "prompts");
			mkdirSync(overrideDir, { recursive: true });

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

			writeFileSync(join(overrideDir, "author-next-phase.md"), overrideContent);

			setTemplateOverrideDir(overrideDir);
			const result = loadTemplate("author-next-phase");
			expect(result.metadata.version).toBe(99);
			expect(result.body).toContain("OVERRIDE TEMPLATE BODY");

			setTemplateOverrideDir(null);
		} finally {
			cleanupDir(dir);
		}
	});

	test("unknown template throws appropriate error", async () => {
		const { loadTemplate } = await import("../../../src/templates/loader.js");
		expect(() => loadTemplate("nonexistent-template")).toThrow(
			/Unknown template/,
		);
	});
});

// ===========================================================================
// Variable substitution
// ===========================================================================

describe("invoke — variable substitution (unit)", () => {
	test("renderTemplate substitutes variables correctly", async () => {
		const { renderTemplate } = await import("../../../src/templates/loader.js");
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
		const { renderTemplate } = await import("../../../src/templates/loader.js");
		expect(() => renderTemplate("author-next-phase", {})).toThrow(
			/missing required variables/,
		);
	});

	test("invoke resolves plan template path internally", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["prd_path", "plan_path", "plan_template_path"],
			{
				prd_path: "docs/requirements.md",
				plan_path: "docs/development/001-plan.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.plan_template_path).toBe(
			"/tmp/project/docs/_implementation_plan_template.md",
		);
	});

	test("invoke resolves review template path internally", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["commit_hash", "review_path", "plan_path", "review_template_path"],
			{
				commit_hash: "abc123",
				review_path: "docs/development/reviews/review.md",
				plan_path: "docs/development/001-plan.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.review_template_path).toBe(
			"/tmp/project/docs/development/reviews/_review_template.md",
		);
	});

	test("explicit template path vars override internal defaults", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["prd_path", "plan_path", "plan_template_path", "review_template_path"],
			{
				prd_path: "docs/requirements.md",
				plan_path: "docs/development/001-plan.md",
				plan_template_path: "/custom/plan.md",
				review_template_path: "/custom/review.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.plan_template_path).toBe("/custom/plan.md");
		expect(vars.review_template_path).toBe("/custom/review.md");
	});
});

// ===========================================================================
// Structured output validation
// ===========================================================================

describe("invoke — structured output validation (unit)", () => {
	test("valid AuthorStatus passes assertion", async () => {
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
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
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
		expect(() =>
			assertAuthorStatus({ result: "complete" }, "test", {
				requireCommit: true,
			}),
		).toThrow(/commit/);
	});

	test("invalid AuthorStatus throws on missing reason", async () => {
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
		expect(() => assertAuthorStatus({ result: "needs_human" }, "test")).toThrow(
			/reason/,
		);
	});

	test("valid ReviewerVerdict passes assertion", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
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

	test("warns (not throws) for ReviewerVerdict with empty items for non-ready", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
		const result = assertReviewerVerdict(
			{ readiness: "not_ready", items: [] },
			"test",
		);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("items");
	});

	test("invalid ReviewerVerdict throws on missing action", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
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

// ===========================================================================
// Structured output error detection
// ===========================================================================

describe("invoke — structured output error detection (unit)", () => {
	test("isStructuredOutputError detects nested StructuredOutputError", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
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
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
		expect(
			isStructuredOutputError({
				error: { name: "StructuredOutputError", message: "oops" },
			}),
		).toBe(true);
	});

	test("isStructuredOutputError returns false for valid result", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
		expect(
			isStructuredOutputError({
				result: "complete",
				commit: "abc123",
			}),
		).toBe(false);
	});

	test("isStructuredOutputError detects object-typed error payloads (P0.2 regression)", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);

		const objError = {
			data: {
				info: {
					error: {
						name: "StructuredOutputError",
						message: "Failed to parse structured output",
					},
				},
			},
			someOtherField: "value",
		};
		expect(typeof objError).toBe("object");
		expect(isStructuredOutputError(objError)).toBe(true);

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

// ===========================================================================
// NDJSON log helpers
// ===========================================================================

describe("invoke — NDJSON log helpers (unit)", () => {
	test("nextLogSequence returns 001 for empty directory", async () => {
		const dir = makeTmpDir();
		try {
			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
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
			writeFileSync(join(dir, "agent-001.ndjson"), "");
			writeFileSync(join(dir, "agent-002.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(dir);
			expect(seq).toBe("003");
		} finally {
			cleanupDir(dir);
		}
	});

	test("nextLogSequence returns 001 for nonexistent directory", async () => {
		const { nextLogSequence } = await import(
			"../../../src/providers/log-writer.js"
		);
		const seq = nextLogSequence("/nonexistent/dir/12345");
		expect(seq).toBe("001");
	});

	test("nextLogSequence handles non-3-digit legacy files (P2)", async () => {
		const dir = makeTmpDir();
		try {
			writeFileSync(join(dir, "agent-1.ndjson"), "");
			writeFileSync(join(dir, "agent-42.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(dir);
			expect(seq).toBe("043");
		} finally {
			cleanupDir(dir);
		}
	});

	test("log directory structure and NDJSON format", () => {
		const dir = makeTmpDir();
		try {
			const logDir = join(dir, ".5x", "logs", "run_test123");
			mkdirSync(logDir, { recursive: true, mode: 0o700 });

			const logPath = join(logDir, "agent-001.ndjson");
			const events: Array<Record<string, unknown>> = [
				{ type: "text", delta: "Hello " },
				{ type: "text", delta: "world" },
				{ type: "usage", tokens: { in: 100, out: 50 }, costUsd: 0.005 },
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

			for (const event of events) {
				const line = JSON.stringify({
					...event,
					ts: new Date().toISOString(),
				});
				writeFileSync(logPath, `${line}\n`, { flag: "a" });
			}

			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf-8").trim();
			const lines = content.split("\n");
			expect(lines.length).toBe(4);

			for (const line of lines) {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				expect(parsed.type).toBeTruthy();
				expect(parsed.ts).toBeTruthy();
			}

			const firstLine = lines[0] ?? "";
			const first = JSON.parse(firstLine) as Record<string, unknown>;
			expect(first.type).toBe("text");
			expect(first.delta).toBe("Hello ");

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

			writeFileSync(join(logDir, "agent-001.ndjson"), "");
			writeFileSync(join(logDir, "agent-002.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(logDir);
			expect(seq).toBe("003");
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Schema contracts
// ===========================================================================

describe("invoke — schema contracts (unit)", () => {
	test("AuthorStatusSchema has correct structure", async () => {
		const { AuthorStatusSchema } = await import("../../../src/protocol.js");
		expect(AuthorStatusSchema.type).toBe("object");
		expect(AuthorStatusSchema.required).toContain("result");
		expect(AuthorStatusSchema.properties.result.enum).toEqual([
			"complete",
			"needs_human",
			"failed",
		]);
	});

	test("ReviewerVerdictSchema has correct structure", async () => {
		const { ReviewerVerdictSchema } = await import("../../../src/protocol.js");
		expect(ReviewerVerdictSchema.type).toBe("object");
		expect(ReviewerVerdictSchema.required).toContain("readiness");
		expect(ReviewerVerdictSchema.required).toContain("items");
	});
});

// ===========================================================================
// CliError and exit codes
// ===========================================================================

describe("invoke — CliError and exit codes (unit)", () => {
	test("TEMPLATE_NOT_FOUND maps to exit code 2", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("TEMPLATE_NOT_FOUND")).toBe(2);
	});

	test("INVALID_STRUCTURED_OUTPUT maps to exit code 7", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("INVALID_STRUCTURED_OUTPUT")).toBe(7);
	});

	test("PROVIDER_NOT_FOUND maps to exit code 2", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("PROVIDER_NOT_FOUND")).toBe(2);
	});

	test("CliError produces correct JSON envelope", async () => {
		const { CliError } = await import("../../../src/output.js");
		const err = new CliError("TEMPLATE_NOT_FOUND", "Template foo not found");
		expect(err.code).toBe("TEMPLATE_NOT_FOUND");
		expect(err.exitCode).toBe(2);
		expect(err.message).toBe("Template foo not found");
	});

	test("CliError with INVALID_STRUCTURED_OUTPUT has exit code 7", async () => {
		const { CliError } = await import("../../../src/output.js");
		const err = new CliError("INVALID_STRUCTURED_OUTPUT", "Bad output", {
			raw: {},
		});
		expect(err.exitCode).toBe(7);
		expect(err.detail).toEqual({ raw: {} });
	});
});

// ===========================================================================
// Provider factory
// ===========================================================================

describe("invoke — provider factory (unit)", () => {
	test("factory defaults to opencode provider", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const config = FiveXConfigSchema.parse({});

		expect(config.author.provider).toBe("opencode");

		const externalConfig = {
			...config,
			opencode: { ...config.opencode, url: "http://127.0.0.1:1" },
		};
		const { createProvider } = await import(
			"../../../src/providers/factory.js"
		);
		let provider: Awaited<ReturnType<typeof createProvider>> | undefined;
		try {
			provider = await createProvider("author", externalConfig);
			expect(provider).toBeDefined();
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				expect((err as { code: string }).code).not.toBe("PROVIDER_NOT_FOUND");
			}
		} finally {
			await provider?.close().catch(() => {});
		}
	});

	test("factory throws PROVIDER_NOT_FOUND for missing plugin", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const config = FiveXConfigSchema.parse({});
		const configWithPlugin = {
			...config,
			author: { ...config.author, provider: "nonexistent-provider" },
		};

		const { createProvider, ProviderNotFoundError } = await import(
			"../../../src/providers/factory.js"
		);
		try {
			await createProvider("author", configWithPlugin);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ProviderNotFoundError);
		}
	});
});

// ===========================================================================
// Enriched output — renderTemplate stepName
// ===========================================================================

describe("invoke — enriched output fields (unit)", () => {
	test("renderTemplate returns stepName for all bundled templates", async () => {
		const { renderTemplate } = await import("../../../src/templates/loader.js");

		const r1 = renderTemplate("author-next-phase", {
			plan_path: "/plan.md",
			phase_number: "1",
			user_notes: "none",
		});
		expect(r1.stepName).toBe("author:implement");

		const r2 = renderTemplate("author-generate-plan", {
			prd_path: "prd.md",
			plan_path: "plan.md",
			plan_template_path: "tpl.md",
		});
		expect(r2.stepName).toBe("author:generate-plan");

		const r3 = renderTemplate("reviewer-commit", {
			commit_hash: "abc",
			review_path: "r.md",
			plan_path: "p.md",
			review_template_path: "t.md",
		});
		expect(r3.stepName).toBe("reviewer:review");
	});
});

// ===========================================================================
// Worktree envelope fields (Phase 2)
// ===========================================================================

describe("invoke — worktree envelope fields (unit)", () => {
	test("output omits worktree_path and worktree_plan_path when no worktree mapping", async () => {
		const dir = makeTmpDir();
		try {
			// Setup: git repo, 5x init, plan file
			Bun.spawnSync(["git", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "config", "user.name", "Test"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const planDir = join(dir, "docs", "development");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(
				join(planDir, "test-plan.md"),
				"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
			);

			// 5x init
			await initScaffold({ startDir: dir });

			// Create run directly in DB (no subprocess)
			const { Database } = await import("bun:sqlite");
			const dbPath = join(dir, ".5x", "5x.db");
			const db = new Database(dbPath);
			const planPath = join(dir, "docs", "development", "test-plan.md");
			const runId = "run_test_no_wt";
			db.exec(
				`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
				 VALUES ('${runId}', '${planPath}', 'active', '{}', datetime('now'), datetime('now'))`,
			);
			db.close();

			// Config using sample provider (direct import, no dynamic resolution contention)
			writeFileSync(
				join(dir, "5x.toml"),
				'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
			);

			// Commit so worktree is clean
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "commit", "-m", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			// Capture stdout from invokeAgent
			const originalLog = console.log;
			let capturedOutput = "";
			console.log = (msg: string) => {
				capturedOutput = msg;
			};

			// Change to temp dir so resolveControlPlaneRoot() finds the right DB
			const originalCwd = process.cwd();
			process.chdir(dir);

			try {
				// Call invokeAgent directly (single subprocess spawn avoided)
				await invokeAgent("author", {
					template: "author-next-phase",
					run: runId,
					vars: [`plan_path=${planPath}`, "phase_number=1", "user_notes=test"],
					quiet: true, // suppress stderr streaming
				});
			} finally {
				process.chdir(originalCwd);
			}

			// Restore console.log
			console.log = originalLog;

			// Parse and verify envelope
			const envelope = JSON.parse(capturedOutput) as {
				ok: boolean;
				data: Record<string, unknown>;
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data.run_id).toBe(runId);
			// Key assertion: no worktree fields when not mapped
			expect(envelope.data.worktree_path).toBeUndefined();
			expect(envelope.data.worktree_plan_path).toBeUndefined();
		} finally {
			cleanupDir(dir);
		}
	});
});
