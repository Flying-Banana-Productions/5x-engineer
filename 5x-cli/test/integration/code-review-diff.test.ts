import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return result.stdout.toString().trim();
}

async function cli(cwd: string, args: string[], stdin?: unknown) {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== undefined) {
		if (!proc.stdin) throw new Error("stdin pipe unavailable");
		proc.stdin.write(JSON.stringify(stdin));
		proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function planMarkdown(): string {
	return `# Governance plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Required behavior | 2 | 0 | - | - | Implements the requested behavior. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

**Completion gate:** The execution run is bound to the approved plan.

- [ ] Bind execution to the approved plan
`;
}

const READY = {
	readiness: "ready",
	items: [],
	baselineAssessment: {
		independentEffortEstimate: 2,
		confidence: "high",
		reason: "The original scope is two points.",
	},
};

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-code-diff-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "core.autocrlf", "false");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "enforced"\n');
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "governance.md");
	writeFileSync(planPath, planMarkdown());
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	return { dir, planPath };
}

async function startRun(dir: string, planPath: string): Promise<string> {
	const runInit = await cli(dir, ["run", "init", "--plan", planPath]);
	if (runInit.exitCode !== 0) {
		throw new Error(`${runInit.stdout}\n${runInit.stderr}`);
	}
	return JSON.parse(runInit.stdout).data.run_id as string;
}

async function approveAndClose(dir: string, planPath: string): Promise<string> {
	const sourceId = await startRun(dir, planPath);
	const review = await cli(
		dir,
		[
			"protocol",
			"validate",
			"reviewer",
			"--run",
			sourceId,
			"--record",
			"--step",
			"reviewer:plan",
			"--phase",
			"plan",
			"--iteration",
			"0",
		],
		READY,
	);
	if (review.exitCode !== 0) {
		throw new Error(`review: ${review.stdout}\n${review.stderr}`);
	}
	const completed = await cli(dir, [
		"run",
		"complete",
		"--run",
		sourceId,
		"--status",
		"completed",
	]);
	if (completed.exitCode !== 0) {
		throw new Error(`${completed.stdout}\n${completed.stderr}`);
	}
	return sourceId;
}

function readJsonl(
	dir: string,
	runId: string,
	stream: string,
): Array<{
	payload: Record<string, unknown>;
}> {
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		"governance",
		runId,
		`${stream}.jsonl`,
	);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
}

function preAuthorCommit(dir: string, runId: string): string | undefined {
	const step = readJsonl(dir, runId, "steps").find(
		(line) => line.payload.step_name === "implementation:pre-author",
	);
	const result = step?.payload.result_json as
		| { preAuthorCommit?: string }
		| undefined;
	return result?.preAuthorCommit;
}

describe("implementation code-review context", () => {
	test(
		"keeps the pre-author base across a multi-commit session and a review-only commit",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				await approveAndClose(dir, planPath);
				const executionId = await startRun(dir, planPath);
				mkdirSync(join(dir, "src"), { recursive: true });
				writeFileSync(join(dir, "src", "old.ts"), "export const value = 1;\n");
				writeFileSync(
					join(dir, "src", "drop.ts"),
					"export const drop = true;\n",
				);
				git(dir, "add", "src");
				git(dir, "commit", "-m", "seed sources");
				const before = git(dir, "rev-parse", "HEAD");
				const firstRender = await cli(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`plan_path=${planPath}`,
				]);
				if (firstRender.exitCode !== 0) {
					throw new Error(`${firstRender.stdout}\n${firstRender.stderr}`);
				}
				expect(preAuthorCommit(dir, executionId)).toBe(before);
				writeFileSync(
					join(dir, "src", "old.ts"),
					"export const value = 1;\n// touch\n",
				);
				const firstCommit = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"add sources",
					"--all-files",
				]);
				if (firstCommit.exitCode !== 0) {
					throw new Error(`${firstCommit.stdout}\n${firstCommit.stderr}`);
				}
				git(dir, "mv", "src/old.ts", "src/new.ts");
				writeFileSync(join(dir, "src", "new.ts"), "export const value = 1; \n");
				rmSync(join(dir, "src", "drop.ts"));
				const secondCommit = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"rename and delete",
					"--all-files",
				]);
				if (secondCommit.exitCode !== 0) {
					throw new Error(`${secondCommit.stdout}\n${secondCommit.stderr}`);
				}
				const end = git(dir, "rev-parse", "HEAD");
				const author = await cli(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						executionId,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--no-phase-checklist-validate",
					],
					{ result: "complete", commit: end },
				);
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				const retry = await cli(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`plan_path=${planPath}`,
					"--new-session",
				]);
				if (retry.exitCode !== 0) {
					throw new Error(`${retry.stdout}\n${retry.stderr}`);
				}
				expect(preAuthorCommit(dir, executionId)).toBe(before);
				const review = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				if (review.exitCode !== 0) {
					throw new Error(`${review.stdout}\n${review.stderr}`);
				}
				const rendered = JSON.parse(review.stdout).data as {
					review_context_id: string;
					prompt: string;
				};
				expect(rendered.review_context_id).toBeTruthy();
				expect(rendered.prompt).toContain(`${before}..${end}`);
				expect(rendered.prompt).toContain("src/new.ts");
				expect(rendered.prompt).toContain("src/drop.ts");
				expect(rendered.prompt).toContain("--no-textconv");
				const context = readJsonl(dir, executionId, "budget").find(
					(line) => line.payload.kind === "implementation-review-context",
				);
				const hunks = context?.payload.hunks as Array<{ text: string }>;
				expect(
					hunks.some(
						(hunk) =>
							hunk.text.includes("value = 1; \n") ||
							hunk.text.includes("value = 1; "),
					),
				).toBe(true);

				mkdirSync(join(dir, "docs", "development", "reviews"), {
					recursive: true,
				});
				writeFileSync(
					join(dir, "docs", "development", "reviews", "note.md"),
					"review notes\n",
				);
				const reviewCommit = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"record review",
					"--all-files",
				]);
				if (reviewCommit.exitCode !== 0) {
					throw new Error(`${reviewCommit.stdout}\n${reviewCommit.stderr}`);
				}
				const again = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
					"--new-session",
				]);
				if (again.exitCode !== 0) {
					throw new Error(`${again.stdout}\n${again.stderr}`);
				}
				const second = JSON.parse(again.stdout).data as {
					review_context_id: string;
					prompt: string;
				};
				expect(second.review_context_id).toBe(rendered.review_context_id);
				expect(second.prompt).toContain(`${before}..${end}`);
				expect(second.prompt).not.toContain(git(dir, "rev-parse", "HEAD"));

				writeFileSync(join(dir, "src", "new.ts"), "export const value = 2;\n");
				const dirty = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				expect(dirty.exitCode).not.toBe(0);
				expect(`${dirty.stdout}\n${dirty.stderr}`).toContain("CODE_DIFF_DIRTY");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"falls back to the earliest git:commit parent and fails when none exists",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await approveAndClose(dir, planPath);
				const executionId = await startRun(dir, planPath);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					executionId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const base = git(dir, "rev-parse", "HEAD");
				mkdirSync(join(dir, "src"), { recursive: true });
				writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
				const first = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"first",
					"--all-files",
				]);
				if (first.exitCode !== 0) {
					throw new Error(`${first.stdout}\n${first.stderr}`);
				}
				writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
				const second = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"second",
					"--all-files",
				]);
				if (second.exitCode !== 0) {
					throw new Error(`${second.stdout}\n${second.stderr}`);
				}
				const end = git(dir, "rev-parse", "HEAD");
				const author = await cli(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						executionId,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--no-phase-checklist-validate",
					],
					{ result: "complete", commit: end },
				);
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				expect(preAuthorCommit(dir, executionId)).toBeUndefined();
				const review = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				if (review.exitCode !== 0) {
					throw new Error(`${review.stdout}\n${review.stderr}`);
				}
				const prompt = JSON.parse(review.stdout).data.prompt as string;
				expect(prompt).toContain(`${base}..${end}`);
				expect(prompt).toContain("src/a.ts");
				expect(prompt).toContain("src/b.ts");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"does not invent a pre-author base from a direct author record",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await approveAndClose(dir, planPath);
				const missingRun = await startRun(dir, planPath);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					missingRun,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const head = git(dir, "rev-parse", "HEAD");
				const onlyAuthor = await cli(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						missingRun,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--no-phase-checklist-validate",
					],
					{ result: "complete", commit: head },
				);
				if (onlyAuthor.exitCode !== 0) {
					throw new Error(`${onlyAuthor.stdout}\n${onlyAuthor.stderr}`);
				}
				const failed = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					missingRun,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${head}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				expect(failed.exitCode).not.toBe(0);
				expect(`${failed.stdout}\n${failed.stderr}`).toContain(
					"CODE_DIFF_MISSING_BASE",
				);
				expect(preAuthorCommit(dir, missingRun)).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"a correction render after commits keeps the earliest commit parent as the review base",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await approveAndClose(dir, planPath);
				const executionId = await startRun(dir, planPath);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					executionId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const base = git(dir, "rev-parse", "HEAD");
				mkdirSync(join(dir, "src"), { recursive: true });
				writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
				const first = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"first",
					"--all-files",
				]);
				if (first.exitCode !== 0) {
					throw new Error(`${first.stdout}\n${first.stderr}`);
				}
				const end = git(dir, "rev-parse", "HEAD");
				const reviewPath = join(
					dir,
					"docs",
					"development",
					"reviews",
					"note.md",
				);
				const correction = await cli(dir, [
					"template",
					"render",
					"author-process-impl-review",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					`review_path=${reviewPath}`,
				]);
				if (correction.exitCode !== 0) {
					throw new Error(`${correction.stdout}\n${correction.stderr}`);
				}
				expect(preAuthorCommit(dir, executionId)).toBeUndefined();
				const review = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				if (review.exitCode !== 0) {
					throw new Error(`${review.stdout}\n${review.stderr}`);
				}
				const rendered = JSON.parse(review.stdout).data as { prompt: string };
				expect(rendered.prompt).toContain(`${base}..${end}`);
				expect(rendered.prompt).toContain(`-C ${dir}`);
				expect(rendered.prompt).toContain("--diff-algorithm=myers");
				expect(preAuthorCommit(dir, executionId)).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"accepts a round-2 enforced verdict with addressed and still-open findings",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await approveAndClose(dir, planPath);
				const executionId = await startRun(dir, planPath);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					executionId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				mkdirSync(join(dir, "src"), { recursive: true });
				writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
				const committed = await cli(dir, [
					"commit",
					"--run",
					executionId,
					"--phase",
					"1",
					"--message",
					"implement",
					"--all-files",
				]);
				if (committed.exitCode !== 0) {
					throw new Error(`${committed.stdout}\n${committed.stderr}`);
				}
				const end = git(dir, "rev-parse", "HEAD");
				const author = await cli(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						executionId,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--no-phase-checklist-validate",
					],
					{ result: "complete", commit: end },
				);
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				const review = await cli(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					executionId,
					"--var",
					"phase_number=1",
					"--var",
					`commit_hash=${end}`,
					"--var",
					`plan_path=${planPath}`,
				]);
				if (review.exitCode !== 0) {
					throw new Error(`${review.stdout}\n${review.stderr}`);
				}
				const contextId = JSON.parse(review.stdout).data
					.review_context_id as string;
				const defect = (id: string) => ({
					id,
					title: `Finding ${id}`,
					action: "auto_fix",
					reason: "The write path drops the status.",
					priority: "P1",
					scopeClass: "implementation_defect",
					effortDelta: 1,
					architectureDelta: 0,
					planWorkItemIds: ["W1"],
				});
				const firstVerdict = await cli(
					dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						executionId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--review-context",
						contextId,
					],
					{
						readiness: "not_ready",
						items: [defect("F1"), defect("F2")],
					},
				);
				if (firstVerdict.exitCode !== 0) {
					throw new Error(`${firstVerdict.stdout}\n${firstVerdict.stderr}`);
				}
				const secondVerdict = await cli(
					dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						executionId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"1",
						"--iteration",
						"2",
						"--review-context",
						contextId,
					],
					{
						readiness: "not_ready",
						priorFindings: [
							{ id: "F1", status: "addressed" },
							{ id: "F2", status: "still_open" },
						],
						items: [defect("F2")],
					},
				);
				if (secondVerdict.exitCode !== 0) {
					throw new Error(`${secondVerdict.stdout}\n${secondVerdict.stderr}`);
				}
				expect(secondVerdict.stdout).not.toContain("PRIOR_FINDING_UNKNOWN");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
