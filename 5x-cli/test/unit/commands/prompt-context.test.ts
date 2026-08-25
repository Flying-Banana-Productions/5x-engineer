/**
 * Unit tests for defaultResolvePromptContext — one DB backs store + runExists.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResolvePromptContext } from "../../../src/commands/prompt-context.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { generateRunId } from "../../../src/run-id.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

function setupProject(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	const db = getDb(dir);
	runMigrations(db);
	closeDb();
	_resetForTest();
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("defaultResolvePromptContext", () => {
	test("returns store + runExists over one DB; missing run is false", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-prompt-ctx-"));
		try {
			setupProject(tmp);
			const ctx = await defaultResolvePromptContext({ startDir: tmp });
			const runId = generateRunId();
			expect(ctx.runExists(runId)).toBe(false);

			const db = getDb(tmp);
			createRunV1(db, { id: runId, planPath: "plan.md" });
			expect(ctx.runExists(runId)).toBe(true);
			expect(ctx.runExists("run_doesnotexist")).toBe(false);

			const created = ctx.store.createPrompt({
				kind: "choose",
				message: "Pick",
				options: ["a", "b"],
				runId,
			});
			const loaded = ctx.store.getPrompt(created.id);
			expect(loaded?.message).toBe("Pick");
			expect(loaded?.runId).toBe(runId);
			expect(loaded?.answeredAt).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
