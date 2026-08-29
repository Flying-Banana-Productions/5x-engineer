/**
 * Integration tests for `5x invoke status` / `5x invoke cancel`.
 *
 * Covers snake_case CLI envelopes, combined `--id --run` intersection,
 * completed sample rows, and unsupported cancel that does not abort the run.
 * Supported once-only cancel lives in unit tests of
 * `requestInvocationCancellation` — the CLI process does not register
 * test adapters.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteInvocationStore } from "../../../src/control-plane/index.js";
import { createRunV1, getRunV1 } from "../../../src/db/operations-v1.js";
import { generateRunId } from "../../../src/run-id.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-registry-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 20000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function setupProjectWithRun(dir: string): Promise<{
	runId: string;
	planPath: string;
}> {
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
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);

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

	const init = await run5x(dir, ["run", "init", "--plan", planPath]);
	const initData = parseJson(init.stdout);
	if (initData.ok !== true) {
		throw new Error(`Failed to init run: ${init.stdout}`);
	}
	const data = initData.data as { run_id: string };
	return { runId: data.run_id, planPath };
}

describe("invoke status/cancel CLI", () => {
	test(
		"sample invoke then status --run: one row with client_state completed",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId, planPath } = await setupProjectWithRun(dir);
				const invoked = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);
				expect(invoked.exitCode).toBe(0);
				expect(parseJson(invoked.stdout).ok).toBe(true);

				const status = await run5x(dir, ["invoke", "status", "--run", runId]);
				expect(status.exitCode).toBe(0);
				const envelope = parseJson(status.stdout);
				expect(envelope.ok).toBe(true);
				const data = envelope.data as {
					invocations: Record<string, unknown>[];
				};
				expect(data.invocations).toHaveLength(1);
				const row = data.invocations[0] ?? {};
				expect(row.client_state).toBe("completed");
				expect(row).not.toHaveProperty("clientState");
				expect(row.run_id).toBe(runId);
				expect(row.status).toBe("completed");
				expect(JSON.stringify(row)).not.toContain("clientState");

				const invocationId = row.id as string;
				const combined = await run5x(dir, [
					"invoke",
					"status",
					"--id",
					invocationId,
					"--run",
					runId,
				]);
				expect(combined.exitCode).toBe(0);
				const combinedData = parseJson(combined.stdout).data as {
					invocation: Record<string, unknown>;
				};
				expect(combinedData.invocation.id).toBe(invocationId);
				expect(combinedData.invocation.client_state).toBe("completed");
				expect(combinedData).not.toHaveProperty("invocations");

				const otherRun = generateRunId();
				const db = new Database(join(dir, ".5x", "5x.db"));
				createRunV1(db, { id: otherRun, planPath: "other.md" });
				db.close();

				const mismatch = await run5x(dir, [
					"invoke",
					"status",
					"--id",
					invocationId,
					"--run",
					otherRun,
				]);
				expect(mismatch.exitCode).toBe(1);
				const mismatchJson = parseJson(mismatch.stdout);
				expect(mismatchJson.ok).toBe(false);
				const error = mismatchJson.error as { code: string; message: string };
				expect(error.code).toBe("INVOCATION_NOT_FOUND");
				expect(error.message).toContain(invocationId);
				expect(error.message).toContain(otherRun);
				expect(JSON.stringify(mismatchJson)).not.toContain('"client_state"');

				const cancelled = await run5x(dir, ["invoke", "cancel", invocationId]);
				expect(cancelled.exitCode).toBe(0);
				const cancelData = parseJson(cancelled.stdout).data as Record<
					string,
					unknown
				>;
				expect(cancelData.adapter_called).toBe(false);
				expect(cancelData.client_state).toBe("completed");
				expect(cancelData.status).toBe("completed");
				expect(cancelData).not.toHaveProperty("clientState");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"cancel on running unsupported row: CANCELLATION_UNSUPPORTED; run stays active",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId } = await setupProjectWithRun(dir);
				const db = new Database(join(dir, ".5x", "5x.db"));
				const store = createSqliteInvocationStore(db);
				const row = store.register({
					runId,
					sessionId: "sess-hang",
					role: "author",
					providerName: "sample",
					templateName: "author-next-phase",
					handle: { adapter: "none", ref: "sess-hang" },
					cancellationSupported: false,
				});
				expect(getRunV1(db, runId)?.status).toBe("active");
				db.close();

				const cancelled = await run5x(dir, ["invoke", "cancel", row.id]);
				expect(cancelled.exitCode).toBe(1);
				const envelope = parseJson(cancelled.stdout);
				expect(envelope.ok).toBe(false);
				const error = envelope.error as { code: string };
				expect(error.code).toBe("CANCELLATION_UNSUPPORTED");

				const after = new Database(join(dir, ".5x", "5x.db"));
				expect(getRunV1(after, runId)?.status).toBe("active");
				const still = createSqliteInvocationStore(after).get(row.id);
				expect(still?.status).toBe("running");
				expect(still?.cancellationRequestedAt).toBeNull();
				after.close();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
