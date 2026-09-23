import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createReviewBudgetStore,
	createWorkingTreeRecordStore,
	recordedEnvelope,
} from "../../../src/index.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";
import { foldGoverningReviewState } from "../../../src/review-governance/decisions.js";
import { fingerprintVerdictItem } from "../../../src/review-governance/fingerprint.js";
import { derivePlanReviewGovernance } from "../../../src/review-governance/routing.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const ORIGIN = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "agent" as const, role: "reviewer" },
};

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function tempDir(): string {
	const dir = join(
		tmpdir(),
		`5x-review-decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function spawn5x(cwd: string, args: string[], stdin?: string) {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== undefined) {
		if (!proc.stdin) throw new Error("stdin pipe unavailable");
		proc.stdin.write(stdin);
		proc.stdin.end();
	}
	return proc;
}

async function collect(
	proc: ReturnType<typeof spawn5x>,
): Promise<CommandResult> {
	const timer = setTimeout(() => proc.kill("SIGINT"), 20_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function run5x(
	cwd: string,
	args: string[],
	stdin?: string,
): Promise<CommandResult> {
	return collect(spawn5x(cwd, args, stdin));
}

async function fixture(
	kind: "baseline" | "finding" | "architecture" = "baseline",
) {
	const dir = tempDir();
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await run5x(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "enforced"\n');
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "gate-plan.md");
	writeFileSync(planPath, "# Gate plan\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	const runInit = await run5x(dir, ["run", "init", "--plan", planPath]);
	if (runInit.exitCode !== 0) throw new Error(runInit.stderr);
	const runId = (JSON.parse(runInit.stdout) as { data: { run_id: string } })
		.data.run_id;
	const records = createWorkingTreeRecordStore({
		recordsRoot: join(dir, "docs", "development", "runs"),
	});
	const budgets = createReviewBudgetStore(records);
	const ledger: ParsedDeliveryBudget = {
		estimateConfidence: "high" as const,
		workItems: [
			{
				id: "W1",
				title: "work",
				effort: 2 as const,
				architectureDelta: 0 as const,
				debtClaim: null,
				addresses: [],
				rationale: "required",
				line: 1,
			},
		],
		surface: {
			subsystems: 1,
			productionFiles: 1,
			persistentOrExternalBoundaries: 0,
		},
	};
	if (kind === "architecture") {
		// Plan 214's aggregate-only alert: B=22, P=6, no item reaches 5.
		const work = ledger.workItems[0];
		if (!work) throw new Error("expected work item");
		ledger.workItems = (
			[
				[3, 1],
				[5, 1],
				[5, 2],
				[3, 1],
				[3, 0],
				[3, 1],
			] as const
		).map(([effort, architectureDelta], index) => ({
			...work,
			id: `W${index + 1}`,
			effort,
			architectureDelta,
		}));
	}
	const baseline = ledger.workItems.reduce(
		(sum, entry) => sum + entry.effort,
		0,
	);
	const estimate = kind === "baseline" ? 5 : baseline;
	budgets.captureBaseline({
		runId,
		captureKind: "initial",
		mode: "enforced",
		parsed: ledger,
		configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
		origin: ORIGIN,
	});
	const item = {
		id: "F1",
		title: "Human acceptance",
		action: "human_required" as const,
		reason: "Operator decision required",
		effortDelta: 1,
		architectureDelta: 0,
		scopeClass: "acceptance_required" as const,
		coupling: "intrinsic" as const,
		estimateConfidence: "high" as const,
		failure: "The plan leaves a material behavior undecided.",
		lowestCostCorrection: "Choose and document the intended behavior.",
	};
	const findings = kind === "finding" ? [item] : [];
	const budget = deriveBudget({
		B0: baseline,
		B: baseline,
		I: estimate,
		workItems: ledger.workItems,
		findings,
		assessments: [],
		config: DEFAULT_REVIEW_BUDGET_CONFIG,
		semanticHumanRequired: kind === "finding",
	});
	const resultJson = {
		readiness: kind === "finding" ? ("not_ready" as const) : ("ready" as const),
		summary: "reviewed",
		items: findings,
		budget,
	};
	const governance = derivePlanReviewGovernance({
		mode: "enforced",
		reviewKind: "initial",
		verdict: resultJson,
		budget,
		budgetContext: { workItems: ledger.workItems, findings, assessments: [] },
		governingState: foldGoverningReviewState({
			b0: baseline,
			decisions: [],
			steps: [],
			budget: [],
		}),
		closure: {
			valid: true,
			accepted: true,
			diagnostics: [],
			requiredOutcomeIds: [],
			findingOutcomes: [],
		},
	});
	records.append({
		runId,
		stream: "steps",
		idempotencyKey: `step:${runId}:reviewer:plan:plan:1`,
		payload: {
			step_name: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			result_json: resultJson,
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		...recordedEnvelope(ORIGIN),
	});
	const finding = {
		findingId: item.id,
		fingerprint: fingerprintVerdictItem(item),
	};
	budgets.appendSnapshot({
		runId,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger,
		findings,
		assessments: [],
		baselineAssessment: {
			independentEffortEstimate: estimate,
			confidence: "high",
			reason: "Independent estimate",
		},
		derived: budget,
		effectiveGateCauses:
			kind === "architecture"
				? governance.gateCauses
				: kind === "baseline"
					? [{ kind: "budget_alert", alert: "baseline_disputed" }]
					: [{ kind: "semantic_human", finding }],
		origin: ORIGIN,
	});
	const shown = await run5x(dir, ["review", "gate", "show", "--run", runId]);
	if (shown.exitCode !== 0) throw new Error(shown.stderr);
	const gate = JSON.parse(shown.stdout).data as {
		gateId: string;
		snapshotId: string;
		eligibleFindings: Array<{ findingId: string; fingerprint: string }>;
		requiredFieldsByChoice: Record<string, string[]>;
	};
	return { dir, runId, records, gate };
}

function decisionData(result: CommandResult) {
	return (
		JSON.parse(result.stdout) as {
			data: {
				created: boolean;
				decision: Record<string, unknown>;
				route: string;
			};
		}
	).data;
}

describe("review decision CLI", () => {
	test(
		"aggregate-only architecture gate accepts flags without IDs and retries through JSON",
		async () => {
			const ctx = await fixture("architecture");
			try {
				expect(
					ctx.gate.requiredFieldsByChoice.approve_architecture_burden,
				).toEqual(["rationale", "approvedP"]);
				const base = [
					"review",
					"decide",
					"--run",
					ctx.runId,
					"--gate",
					ctx.gate.gateId,
				];
				const rationale = "Approve the six-point aggregate architecture burden";
				const result = await run5x(ctx.dir, [
					...base,
					"--choice",
					"approve_architecture_burden",
					"--approved-p",
					"6",
					"--rationale",
					rationale,
				]);
				expect(result.exitCode).toBe(0);
				const accepted = decisionData(result);
				expect(accepted).toMatchObject({ created: true, route: "complete" });
				expect(accepted.decision.architectureApproval).toEqual({
					approvedP: 6,
					approvedItemIds: [],
					approvedWorkItemIds: [],
				});
				const retry = await run5x(ctx.dir, [
					...base,
					"--input-json",
					JSON.stringify({
						choice: "approve_architecture_burden",
						rationale,
						approvedP: 6,
						approvedItemIds: [],
						approvedWorkItemIds: [],
					}),
				]);
				expect(retry.exitCode).toBe(0);
				expect(decisionData(retry)).toMatchObject({
					created: false,
					route: "complete",
					decision: { decisionId: accepted.decision.decisionId },
				});
				expect(ctx.records.listLines(ctx.runId, "decisions")).toHaveLength(1);
				const shown = await run5x(ctx.dir, [
					"review",
					"gate",
					"show",
					"--run",
					ctx.runId,
				]);
				expect(shown.exitCode).toBe(0);
				expect(JSON.parse(shown.stdout)).toMatchObject({
					ok: true,
					data: { open: false },
				});
			} finally {
				rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"two independent processes converge on one gate decision and human step",
		async () => {
			const ctx = await fixture();
			try {
				const args = [
					"review",
					"decide",
					"--run",
					ctx.runId,
					"--gate",
					ctx.gate.gateId,
					"--choice",
					"retain_baseline",
					"--rationale",
					"retain the reviewed estimate",
				];
				const [left, right] = await Promise.all([
					collect(spawn5x(ctx.dir, args)),
					collect(spawn5x(ctx.dir, args)),
				]);
				if (left.exitCode !== 0)
					throw new Error(`left failed: ${left.stdout}\n${left.stderr}`);
				if (right.exitCode !== 0)
					throw new Error(`right failed: ${right.stdout}\n${right.stderr}`);
				const results = [decisionData(left), decisionData(right)];
				expect(results.map((result) => result.created).sort()).toEqual([
					false,
					true,
				]);
				expect(results[0]?.decision.decisionId).toBe(
					results[1]?.decision.decisionId,
				);
				expect(ctx.records.listLines(ctx.runId, "decisions")).toHaveLength(1);
				expect(
					ctx.records
						.listLines(ctx.runId, "steps")
						.filter(
							(line) =>
								(line.payload as { step_name?: string }).step_name ===
								"human:review-governance",
						),
				).toHaveLength(1);
				const conflict = await run5x(ctx.dir, [
					"review",
					"decide",
					"--run",
					ctx.runId,
					"--gate",
					ctx.gate.gateId,
					"--choice",
					"adjust_baseline",
					"--baseline",
					"4",
					"--rationale",
					"use a different estimate",
				]);
				expect(conflict.exitCode).not.toBe(0);
				expect(conflict.stdout).toContain("REVIEW_GATE_ALREADY_RESOLVED");
			} finally {
				rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"flag, inline JSON, and stdin JSON resolve the same finding identity",
		async () => {
			const decisions: Array<Record<string, unknown>> = [];
			for (const form of ["flags", "inline", "stdin"] as const) {
				const ctx = await fixture("finding");
				try {
					const finding = ctx.gate.eligibleFindings[0];
					if (!finding) throw new Error("missing eligible finding");
					if (form === "flags") {
						const mismatched = await run5x(ctx.dir, [
							"review",
							"decide",
							"--run",
							ctx.runId,
							"--gate",
							ctx.gate.gateId,
							"--input-json",
							JSON.stringify({
								choice: "defer_accept_risk",
								rationale: "mismatched identity",
								evidence: ["evidence"],
								findingRefs: [{ ...finding, fingerprint: "sha256:stale" }],
							}),
						]);
						expect(mismatched.exitCode).not.toBe(0);
						expect(mismatched.stdout).toContain(
							"REVIEW_DECISION_FINDING_INVALID",
						);
						const mixed = await run5x(ctx.dir, [
							"review",
							"decide",
							"--run",
							ctx.runId,
							"--gate",
							ctx.gate.gateId,
							"--input-json",
							JSON.stringify({
								choice: "abort",
								rationale: "stop",
							}),
							"--choice",
							"abort",
						]);
						expect(mixed.exitCode).not.toBe(0);
						expect(mixed.stdout).toContain("INVALID_ARGS");
						const inapplicable = await run5x(ctx.dir, [
							"review",
							"decide",
							"--run",
							ctx.runId,
							"--gate",
							ctx.gate.gateId,
							"--choice",
							"trade_scope",
							"--rationale",
							"change scope",
							"--retain",
							"required behavior",
							"--baseline",
							"3",
						]);
						expect(inapplicable.exitCode).not.toBe(0);
						expect(inapplicable.stdout).toContain(
							"REVIEW_DECISION_FIELD_NOT_ALLOWED",
						);
						expect(ctx.records.listLines(ctx.runId, "decisions")).toHaveLength(
							0,
						);
					}
					const payload = {
						choice: "defer_accept_risk",
						rationale: "accept this bounded risk",
						evidence: ["operator reviewed the concrete failure"],
						findingRefs: [finding],
					};
					const base = [
						"review",
						"decide",
						"--run",
						ctx.runId,
						"--gate",
						ctx.gate.gateId,
					];
					const result =
						form === "flags"
							? await run5x(ctx.dir, [
									...base,
									"--choice",
									payload.choice,
									"--rationale",
									payload.rationale,
									"--evidence",
									payload.evidence[0] as string,
									"--finding",
									finding.findingId,
								])
							: await run5x(
									ctx.dir,
									[
										...base,
										"--input-json",
										form === "inline" ? JSON.stringify(payload) : "-",
									],
									form === "stdin" ? JSON.stringify(payload) : undefined,
								);
					expect(result.exitCode).toBe(0);
					decisions.push(decisionData(result).decision);
				} finally {
					rmSync(ctx.dir, { recursive: true, force: true });
				}
			}
			for (const decision of decisions) {
				expect(decision.choice).toBe("defer_accept_risk");
				expect(decision.findingRefs).toEqual(decisions[0]?.findingRefs);
				expect(decision.evidence).toEqual(decisions[0]?.evidence);
				expect(decision.approvedScope).toEqual(decisions[0]?.approvedScope);
			}
		},
		{ timeout: 30_000 },
	);
});
