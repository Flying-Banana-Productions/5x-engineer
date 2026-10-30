import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wrapEquivalentPlan } from "../../../src/review-governance/schema-migration.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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

function parseEnvelope(result: { stdout: string; stderr: string }): {
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string };
} {
	const line =
		result.stdout
			.split("\n")
			.filter((entry) => entry.startsWith("{"))
			.at(-1) ?? "";
	try {
		return JSON.parse(line) as {
			ok: boolean;
			data?: Record<string, unknown>;
			error?: { code: string; message: string };
		};
	} catch {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

function migrationPayloads(dir: string): unknown[] {
	const root = join(dir, "docs", "development", "runs");
	if (!existsSync(root)) return [];
	const found: unknown[] = [];
	for (const slug of readdirSync(root)) {
		const slugDir = join(root, slug);
		for (const runId of readdirSync(slugDir)) {
			const path = join(slugDir, runId, "budget.jsonl");
			if (!existsSync(path)) continue;
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line) continue;
				const parsed = JSON.parse(line) as { payload?: { kind?: string } };
				if (parsed.payload?.kind === "plan-schema-migration") {
					found.push(parsed.payload);
				}
			}
		}
	}
	return found;
}

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-plan-migrate-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) {
		throw new Error(`${initialized.stdout}\n${initialized.stderr}`);
	}
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "advisory"\n');
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

async function approvePlan(dir: string, runId: string): Promise<void> {
	const review = await cli(
		dir,
		[
			"protocol",
			"validate",
			"reviewer",
			"--run",
			runId,
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
		throw new Error(`${review.stdout}\n${review.stderr}`);
	}
}

async function completeRun(dir: string, runId: string): Promise<void> {
	const result = await cli(dir, [
		"run",
		"complete",
		"--run",
		runId,
		"--status",
		"completed",
	]);
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

async function recordAuthor(dir: string, runId: string) {
	return cli(
		dir,
		[
			"protocol",
			"validate",
			"author",
			"--run",
			runId,
			"--record",
			"--step",
			"author:implement",
			"--phase",
			"1",
			"--iteration",
			"1",
			"--no-phase-checklist-validate",
		],
		{ result: "complete", commit: "abc123def" },
	);
}

describe("5x plan migrate", () => {
	test(
		"wraps an unapproved plan once and writes no migration record",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const runId = await startRun(dir, planPath);
				const first = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"equivalent",
					"--write",
				]);
				const written = parseEnvelope(first);
				expect(first.exitCode).toBe(0);
				expect(written.data?.wrote).toBe(true);
				expect(written.data?.unchanged).toBe(false);
				expect(String(written.data?.message)).toContain("ordinary plan review");
				const bytes = readFileSync(planPath, "utf8");
				expect(bytes.match(/<!-- 5x:plan-schema:1 -->/g)).toHaveLength(1);
				expect(bytes).toContain("<!-- 5x:contract:start -->");
				expect(bytes).toContain(planMarkdown());
				const second = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"equivalent",
					"--write",
				]);
				const again = parseEnvelope(second);
				expect(second.exitCode).toBe(0);
				expect(again.data?.wrote).toBe(false);
				expect(again.data?.unchanged).toBe(true);
				expect(readFileSync(planPath, "utf8")).toBe(bytes);
				expect(migrationPayloads(dir)).toHaveLength(0);
				git(dir, "add", "-A");
				git(dir, "commit", "-m", "wrap");
				await approvePlan(dir, runId);
				await completeRun(dir, runId);
				const refused = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"equivalent",
					"--write",
				]);
				const error = parseEnvelope(refused);
				expect(refused.exitCode).not.toBe(0);
				expect(error.error?.code).toBe("PLAN_MIGRATION_CONFLICT");
				expect(error.error?.message).toContain("5x review migrate-schema");
				expect(readFileSync(planPath, "utf8")).toBe(bytes);
				expect(migrationPayloads(dir)).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);

	test(
		"refuses a plan that already has an implementation binding",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				const author = await recordAuthor(dir, executionId);
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				const before = readFileSync(planPath, "utf8");
				const refused = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"equivalent",
					"--write",
				]);
				const error = parseEnvelope(refused);
				expect(refused.exitCode).not.toBe(0);
				expect(error.error?.code).toBe("PLAN_MIGRATION_CONFLICT");
				expect(error.error?.message).toContain("5x review migrate-schema");
				expect(readFileSync(planPath, "utf8")).toBe(before);
				expect(migrationPayloads(dir)).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);

	test(
		"selective --write validates an edited schema 1 file and does not rewrite it",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const edited = wrapEquivalentPlan(planMarkdown());
				writeFileSync(planPath, edited);
				const before = statSync(planPath);
				const result = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"selective",
					"--write",
				]);
				const written = parseEnvelope(result);
				expect(result.exitCode).toBe(0);
				expect(written.data?.wrote).toBe(false);
				expect(written.data?.unchanged).toBe(true);
				expect(written.data?.schema).toBe(1);
				expect(readFileSync(planPath, "utf8")).toBe(edited);
				expect(statSync(planPath).mtimeMs).toBe(before.mtimeMs);
				expect(migrationPayloads(dir)).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);
});
