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

type Envelope = {
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string; detail?: Record<string, unknown> };
};

function envelope(result: { stdout: string; stderr: string }): Envelope {
	const line =
		result.stdout
			.split("\n")
			.filter((entry) => entry.startsWith("{"))
			.at(-1) ?? "";
	try {
		return JSON.parse(line) as Envelope;
	} catch {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

function ok(result: { stdout: string; stderr: string; exitCode: number }) {
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
	return envelope(result);
}

const BUDGET = `## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Booking preview | 2 | 0 | - | - | Implements the preview. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

`;

/** Draft with gate lists but no task markers. */
function draft(budget: boolean): string {
	return `# Booking preview

**Status:** Draft

${budget ? BUDGET : ""}## Phase 1: Preview model

**Completion gate:** Preview data is typed.

- Add the preview type
- Map API fields

## Phase 2: Modal

**Completion gate:** The modal renders.

- Render the modal
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

async function setup(mode: "enforced" | "advisory" | "off", budget: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "5x-plan-executability-"));
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) {
		throw new Error(`${initialized.stdout}\n${initialized.stderr}`);
	}
	writeFileSync(join(dir, "5x.toml"), `[reviewBudget]\nmode = "${mode}"\n`);
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "preview.md");
	writeFileSync(planPath, draft(budget));
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	const init = ok(await cli(dir, ["run", "init", "--plan", planPath]));
	return { dir, planPath, runId: String(init.data?.run_id) };
}

function runLines(dir: string, runId: string, stream: string): unknown[] {
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		"preview",
		runId,
		`${stream}.jsonl`,
	);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

const FLOWS = [
	{ name: "enforced", mode: "enforced", budget: true },
	{ name: "advisory", mode: "advisory", budget: true },
	{ name: "off", mode: "off", budget: true },
	{
		name: "non-budgeted (off, no Delivery Budget)",
		mode: "off",
		budget: false,
	},
] as const;

describe("plan executability before review", () => {
	for (const flow of FLOWS) {
		test.serial(
			`${flow.name}: a non-executable draft routes to the author, then the same review proceeds`,
			async () => {
				const { dir, planPath, runId } = await setup(flow.mode, flow.budget);
				try {
					const render = () =>
						cli(dir, [
							"template",
							"render",
							"reviewer-plan",
							"--run",
							runId,
							"--var",
							`plan_path=${planPath}`,
						]);
					const blocked = await render();
					expect(blocked.exitCode).not.toBe(0);
					const refusal = envelope(blocked).error;
					expect(refusal?.code).toBe("PLAN_REPAIR_REQUIRED");
					expect(refusal?.detail?.reviewRoute).toBe("author_revision");
					const next = refusal?.detail?.next as string[];
					expect(next).toHaveLength(1);
					expect(next[0]).toContain("5x plan repair-checklists --plan ");
					expect(next[0]).toEndWith("--dry-run");
					// No reviewer iteration, baseline or gate was consumed.
					expect(runLines(dir, runId, "budget")).toHaveLength(0);
					expect(runLines(dir, runId, "decisions")).toHaveLength(0);

					if (flow.mode === "off") {
						// Recording a verdict needs an executable plan in off mode too.
						const recorded = await cli(
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
						expect(recorded.exitCode).not.toBe(0);
						expect(envelope(recorded).error?.code).toBe("PLAN_REPAIR_REQUIRED");
						expect(JSON.stringify(runLines(dir, runId, "steps"))).not.toContain(
							"reviewer:plan",
						);
					}

					// Inspection stays usable and names the same repair.
					const phases = ok(await cli(dir, ["plan", "phases", planPath]));
					expect(
						(
							(phases.data?.phases ?? []) as Array<{ checklist_total: number }>
						).map((phase) => phase.checklist_total),
					).toEqual([0, 0]);
					expect(
						((phases.data?.executability ?? { next: [] }) as { next: string[] })
							.next,
					).toEqual(next);

					// The author runs the named preview, applies it, and re-renders.
					const preview = ok(
						await cli(dir, next[0]?.split(" ").slice(1) ?? []),
					);
					ok(
						await cli(dir, [
							"plan",
							"repair-checklists",
							"--plan",
							planPath,
							"--apply",
							"--intent",
							String(preview.data?.intentDigest),
						]),
					);
					const resumed = await render();
					if (resumed.exitCode !== 0) {
						throw new Error(`${resumed.stdout}\n${resumed.stderr}`);
					}
					expect(envelope(resumed).ok).toBe(true);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
			{ timeout: 60000 },
		);
	}

	test.serial(
		"valid prose gates and ordinary bullets render without new diagnostics",
		async () => {
			const { dir, planPath, runId } = await setup("enforced", true);
			try {
				writeFileSync(
					planPath,
					draft(true)
						.replace("- Add the preview type", "- [ ] Add the preview type")
						.replace("- Map API fields", "- [ ] Map API fields")
						.replace(
							"- Render the modal",
							"Background:\n\n- The modal already exists.\n\n- [ ] Render the modal",
						),
				);
				const rendered = ok(
					await cli(dir, [
						"template",
						"render",
						"reviewer-plan",
						"--run",
						runId,
						"--var",
						`plan_path=${planPath}`,
					]),
				);
				expect(rendered.ok).toBe(true);
				const phases = ok(await cli(dir, ["plan", "phases", planPath]));
				expect(phases.data?.executability).toEqual({
					executable: true,
					diagnostics: [],
					next: [],
				});
				const text = await cli(dir, ["--text", "plan", "phases", planPath]);
				expect(text.exitCode).toBe(0);
				expect(text.stdout).not.toContain("Diagnostics:");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60000 },
	);
});
