/**
 * Plan 217 Phase 1: `author-issue-intake` renders natively and through
 * `5x invoke`, records as `author:issue-intake` in phase `plan`, and never
 * triggers implementation admission or binding.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	commitAllSync,
	copyInitializedRepo,
} from "../../helpers/git-fixture.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-issue-intake-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
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

async function setupProjectWithPlanningRun(dir: string): Promise<{
	runId: string;
	planPath: string;
	briefDir: string;
}> {
	copyInitializedRepo(dir);
	const plansDir = join(dir, "docs", "development", "plans");
	mkdirSync(plansDir, { recursive: true });
	// The plan is not authored yet during intake; the run is keyed to its path.
	const planPath = join(plansDir, "218-issue-42-example.md");
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(
		join(dir, "5x.toml"),
		[
			"[author]",
			'provider = "sample"',
			'model = "sample/test-model"',
			"",
			"[reviewer]",
			'provider = "sample"',
			'model = "sample/test"',
			"",
			"[sample]",
			"echo = false",
			"",
			"[sample.structured]",
			'result = "complete"',
			'commit = "abc123"',
			"",
		].join("\n"),
	);
	commitAllSync(dir, "init");

	const init = await run5x(dir, ["run", "init", "--plan", planPath]);
	const initJson = parseJson(init.stdout) as {
		ok: boolean;
		data: { run_id: string; plan_path: string };
	};
	if (!initJson.ok) throw new Error(`run init failed: ${init.stdout}`);
	return {
		runId: initJson.data.run_id,
		planPath: initJson.data.plan_path,
		briefDir: join(
			dir,
			"docs",
			"development",
			"issues",
			"218-issue-42-example",
		),
	};
}

describe("author-issue-intake under phase plan", () => {
	test(
		"render and invoke record author:issue-intake without implementation admission",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId, planPath, briefDir } =
					await setupProjectWithPlanningRun(dir);
				const vars = [
					"--var",
					"issue_ref=acme/widgets#42",
					"--var",
					`brief_dir=${briefDir}`,
					"--var",
					`plan_path=${planPath}`,
				];

				const rendered = await run5x(dir, [
					"template",
					"render",
					"author-issue-intake",
					"--run",
					runId,
					...vars,
				]);
				expect(rendered.exitCode).toBe(0);
				const renderJson = parseJson(rendered.stdout);
				expect(renderJson.ok).toBe(true);
				const renderData = renderJson.data as Record<string, unknown>;
				expect(renderData.step_name).toBe("author:issue-intake");
				const prompt = String(renderData.prompt);
				expect(prompt).toContain(
					"<!-- 5x:issue-source v1 github.com/OWNER/REPO#N -->",
				);
				expect(prompt).toContain(
					`5x commit --run ${runId} --phase plan --files ${briefDir}`,
				);
				expect(prompt).not.toContain("Admitted implementation work");

				const invoked = await run5x(dir, [
					"invoke",
					"author",
					"author-issue-intake",
					"--run",
					runId,
					"--record",
					"--record-step",
					"author:issue-intake",
					"--phase",
					"plan",
					...vars,
				]);
				expect(invoked.exitCode).toBe(0);
				const invokeJson = parseJson(invoked.stdout);
				expect(invokeJson.ok).toBe(true);
				const invokeData = invokeJson.data as Record<string, unknown>;
				expect(invokeData.step_name).toBe("author:issue-intake");

				const state = await run5x(dir, ["run", "state", "--run", runId]);
				const stateJson = parseJson(state.stdout);
				expect(stateJson.ok).toBe(true);
				const stateData = stateJson.data as Record<string, unknown>;
				const steps = stateData.steps as Array<Record<string, unknown>>;
				const names = steps.map((s) => String(s.step_name));
				expect(names).toContain("author:issue-intake");
				const intake = steps.find((s) => s.step_name === "author:issue-intake");
				expect(intake?.phase).toBe("plan");
				for (const name of names) {
					expect(name.startsWith("implementation:")).toBe(false);
				}
				const governance = stateData.implementation_governance as
					| Record<string, unknown>
					| undefined;
				expect(governance?.binding ?? null).toBeNull();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60000 },
	);
});
