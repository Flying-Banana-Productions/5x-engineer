import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function plan(addresses = "-"): string {
	return `# Governance plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Required behavior | 2 | 0 | - | ${addresses} | Implements the requested behavior. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0
`;
}

describe("plan-review governance lifecycle", () => {
	test(
		"converges from exhaustive initial findings to addressed-only closure and preserves pinned enforcement",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "5x-governance-e2e-"));
			try {
				git(dir, "init");
				git(dir, "config", "user.email", "test@test.com");
				git(dir, "config", "user.name", "Test");
				const initialized = await cli(dir, ["init"]);
				if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
				writeFileSync(
					join(dir, "5x.toml"),
					'[reviewBudget]\nmode = "enforced"\n',
				);
				const planDir = join(dir, "docs", "development", "plans");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "governance.md");
				writeFileSync(planPath, plan());
				git(dir, "add", "-A");
				git(dir, "commit", "-m", "fixture");
				const runInit = await cli(dir, ["run", "init", "--plan", planPath]);
				if (runInit.exitCode !== 0) throw new Error(runInit.stderr);
				const runId = JSON.parse(runInit.stdout).data.run_id as string;
				const finding = {
					id: "P0.1",
					title: "Missing failure handling",
					action: "auto_fix",
					reason: "The plan omits a required failure path.",
					scopeClass: "acceptance_required",
					effortDelta: 1,
					architectureDelta: 0,
					coupling: "intrinsic",
					estimateConfidence: "high",
					failure: "The required operation can fail without recovery.",
					lowestCostCorrection: "Document the recovery path in W1.",
				};
				const initial = await cli(
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
					{
						readiness: "not_ready",
						items: [finding],
						baselineAssessment: {
							independentEffortEstimate: 2,
							confidence: "high",
							reason: "The original scope is two points.",
						},
					},
				);
				if (initial.exitCode !== 0)
					throw new Error(`initial: ${initial.stdout}\n${initial.stderr}`);
				expect(JSON.parse(initial.stdout).data.result.governance.route).toBe(
					"author_revision",
				);

				writeFileSync(
					planPath,
					`${plan("P0.1")}\nThe W1 recovery path is explicit.\n`,
				);
				git(dir, "add", planPath);
				git(dir, "commit", "-m", "address finding");
				const closure = await cli(
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
						"1",
					],
					{
						readiness: "ready",
						items: [],
						priorFindings: [{ id: "P0.1", status: "addressed" }],
					},
				);
				if (closure.exitCode !== 0)
					throw new Error(`closure: ${closure.stdout}\n${closure.stderr}`);
				const closureResult = JSON.parse(closure.stdout).data.result;
				expect(closureResult.items).toEqual([]);
				expect(closureResult.governance).toMatchObject({
					reviewKind: "closure",
					normalizedReadiness: "ready",
					route: "complete",
				});

				// A later config edit cannot demote the baseline captured for this run.
				writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "off"\n');
				const state = await cli(dir, ["run", "state", "--run", runId]);
				if (state.exitCode !== 0) throw new Error(state.stderr);
				const data = JSON.parse(state.stdout).data;
				expect(data.review_budget.mode).toBe("enforced");
				expect(data.review_governance).toMatchObject({
					normalized_route: "complete",
					normalized_readiness: "ready",
				});
				expect(readFileSync(planPath, "utf8")).toContain("P0.1");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30_000 },
	);
});
