import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { invokeAgent } from "../../../src/commands/invoke.handler.js";
import { protocolEmitReviewer } from "../../../src/commands/protocol-emit.handler.js";
import { templateRender } from "../../../src/commands/template.handler.js";
import { recordedEnvelope } from "../../../src/control-plane/record-types.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { getDefaultSkillRaw } from "../../../src/harnesses/opencode/skills/loader.js";
import type { AgentProvider } from "../../../src/providers/types.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	type ImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	appendPlanReviewPromptContext,
	buildImplementationReviewPromptContext,
	formatImplementationAuthorContext,
	formatImplementationReviewerContext,
	type ImplementationReviewPromptContext,
} from "../../../src/review-governance/context.js";
import { createImplementationDecision } from "../../../src/review-governance/decisions.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";
import {
	renderTemplate,
	setTemplateOverrideDir,
} from "../../../src/templates/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "../commands/review-budget-test-helpers.js";

const promptContext: ImplementationReviewPromptContext = {
	reviewKind: "closure",
	mode: "enforced",
	bindingId: "binding-1",
	sourceRunId: "source-run",
	sourceSnapshotId: "snap-1",
	approvedPlanCommit: "a".repeat(40),
	phaseId: "1",
	phaseHeading: "Phase 1",
	approvedWorkItemIds: ["W1"],
	phaseScope: ["1: Phase 1", "W1: Work"],
	reviewContextId: "ctx-1",
	fullDiffRetrieval: "git diff aaa..bbb -- .",
	requiredOutcomeIds: ["I1"],
	dueClaims: [
		{
			creditClaimId: "DC1",
			phaseId: "1",
			approvedArchitectureDelta: -2,
			effectiveMagnitude: 1,
			after: "one store",
			waiverDecisionId: "decision-waive",
		},
	],
	deferredOrAcceptedRisks: [
		{
			decisionId: "decision-risk",
			findingId: "P1.1",
			title: "Imported latency risk",
			rationale: "Accepted for this phase.",
			approvedScope: ["W1"],
			source: "imported",
		},
	],
	debtWaivers: [
		{
			decisionId: "decision-waive",
			creditClaimId: "DC1",
			approvedMagnitude: 1,
			originalMagnitude: 2,
		},
	],
	authorRoute: "author_revision",
	authorNextAction: "author_revision",
	finalCorrection: false,
	eligibleItemId: null,
	actionableFindings: [
		{
			id: "I1",
			title: "Missing guard",
			scopeClass: "implementation_defect",
			priority: "P2",
			action: "auto_fix",
			reason: "Restore the existing check.",
			planWorkItemIds: ["W1"],
		},
	],
	textGuard: {
		id: "guard-1",
		spans: [{ heading: "Phase 1", staleText: "old sentence" }],
	},
};

function binding(): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: "run1",
		sourceRunId: "source-run",
		sourceSnapshotId: "snap-1",
		sourceBaselineId: "base-1",
		approvedPlanCommit: "c".repeat(40),
		approvedPlanHash: "sha256:plan",
		approvedPlanBytes: "# Plan\n",
		b0: 8,
		governingB: 8,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W1",
					title: "Bind execution",
					effort: 2,
					architectureDelta: -2,
					debtClaim: {
						debtClaimId: "DC1",
						coupling: "intrinsic",
						targetPhase: "1",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: -1,
						before: "two stores",
						after: "one binding",
					},
					addresses: ["P1.1"],
					rationale: "Required",
					line: 1,
				},
			],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
		effectiveDecisions: [
			{
				kind: "plan-review-governance",
				version: 1,
				decisionId: "11111111-1111-4111-8111-111111111111",
				gateId: "gate-1",
				snapshotId: "snap-1",
				choice: "defer_accept_risk",
				decisionIntentHash: `sha256:${"ab".repeat(32)}`,
				findingRefs: [{ findingId: "P1.1", fingerprint: "sha256:risk" }],
				rationale: "Imported accepted risk.",
				evidence: ["Operator note"],
				approvedScope: { retained: ["W1"], removed: [] },
				createdAt: "2026-01-01 00:00:00",
			},
		],
		phaseMap: [{ id: "1", heading: "Phase 1" }],
		debtTargets: [{ claimId: "DC1", sourceLabel: "phase-1", phaseId: "1" }],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-01-01 00:00:00",
	};
}

const roleCases = [
	{ context: createRenderContext(true), reviewerNative: true },
	{ context: createRenderContext(false), reviewerNative: false },
	{ context: createRenderContext(false, true, false), reviewerNative: false },
	{ context: createRenderContext(false, false, true), reviewerNative: true },
];

describe("implementation review skill branches", () => {
	test("renders governance routes for all four role-mode combinations", () => {
		for (const { context, reviewerNative } of roleCases) {
			const content = renderSkillByName("5x-phase-execution", context).content;
			expect(content).toContain("`complete`");
			expect(content).toContain("`author_revision`");
			expect(content).toContain("`final_corrections`");
			expect(content).toContain("`human_gate`");
			expect(content).toContain(".data.result.governance.route");
			expect(content).toContain("Review kind: closure");
			expect(content).toContain("`--prior-finding`");
			expect(content).toContain("When Step 4 routed\n  `final_corrections`");
			expect(content).toContain(
				"A passing finish goes to Step 6. Any invalidation returns to Step 2",
			);
			if (reviewerNative) {
				expect(content).toContain(
					'VALIDATED=$(echo "$RESULT" | 5x protocol validate reviewer',
				);
				expect(content).toContain('ROUTE_JSON="$VALIDATED"');
				expect(content).toContain(
					"echo \"$VALIDATED\" | jq -r '.data.result.readiness // empty'",
				);
				expect(content).toContain(
					"echo \"$VALIDATED\" | jq -r '.data.result.items | length'",
				);
				expect(content).toContain(
					"echo \"$ROUTE_JSON\" | jq -r '.data.result.governance.route // empty'",
				);
			} else {
				expect(content).not.toContain("VALIDATED=");
				expect(content).toContain(
					"echo \"$ROUTE_JSON\" | jq -r '.data.result.governance.route // empty'",
				);
			}
			expect(content).toContain("5x review corrections finish");
			expect(content).toContain("5x review decide --gate");
			expect(content).toContain("5x review implementation bind");
			expect(content).toContain("pre_author_commit");
			expect(content).toContain("IMPLEMENTATION_APPROVAL_REQUIRED");
			expect(content).toContain("Never continue that failure as v1");
			expect(content).toContain("harness_freshness");
			expect(content).toContain("Delegation mode precedence");
			expect(content).toContain("maxReviewIterations");
			expect(content).toContain("--new-session");
			expect(content).toContain("--continue-native");
			expect(content).not.toContain("baselineAssessment");
			expect(content).not.toContain("projectedEffort");
		}
	});

	test("loads current skill content rather than an installed copy", () => {
		const loaded = getDefaultSkillRaw("5x-phase-execution");
		const rendered = renderSkillByName(
			"5x-phase-execution",
			createRenderContext(true),
		).content;
		expect(loaded).toContain("5x review corrections finish");
		expect(loaded).toContain("task_id=");
		expect(rendered).toContain("[[NATIVE_CONTINUE_PARAM]]");
		expect(loaded).not.toContain("[[NATIVE_CONTINUE_PARAM]]");
	});
});

describe("implementation prompt context", () => {
	test("formats reviewer closure rules and admitted author findings", () => {
		const governance = formatImplementationReviewerContext(promptContext);
		const author = formatImplementationAuthorContext(promptContext);
		const rendered = appendPlanReviewPromptContext({
			prompt: "native template\n## Implementation Diff\n\nrange\n",
			governanceAppend: governance,
		});
		expect(rendered).toContain("Binding: binding-1");
		expect(rendered).toContain("### Closure rules");
		expect(rendered).toContain("--prior-finding");
		expect(rendered).toContain("Source run: source-run");
		expect(rendered).toContain("Approved work-item IDs: W1");
		expect(rendered).toContain("Full diff retrieval: `git diff aaa..bbb -- .`");
		expect(rendered).toContain("Required prior-finding outcome IDs: I1");
		expect(rendered).toContain("DC1");
		expect(rendered).toContain("Imported latency risk");
		expect(rendered).toContain("decision decision-risk");
		expect(rendered).toContain("approved scope: W1");
		expect(rendered).toContain("decision decision-waive");
		expect(author).toContain("Implement only the admitted findings");
		expect(author).toContain(
			"P1.1 (Imported latency risk, decision decision-risk)",
		);
		expect(author).toContain("old sentence");
		expect(author).not.toContain("baselineAssessment");
		expect(governance).not.toContain("B0");
	});

	test("a fresh session does not reset imported risk or due claims", () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.store.saveImplementationBinding(
			binding(),
			ctx.originFor({
				kind: "system",
				role: "cli",
			}),
		);
		const fresh = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
			sessionId: "new",
		});
		const continued = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
			sessionId: "session-1",
		});
		expect(fresh).toEqual(continued);
		expect(fresh?.reviewKind).toBe("initial");
		expect(fresh?.dueClaims[0]?.creditClaimId).toBe("DC1");
		expect(fresh?.deferredOrAcceptedRisks[0]?.source).toBe("imported");
		expect(fresh?.deferredOrAcceptedRisks[0]?.title).toBe("P1.1");
		expect(fresh?.deferredOrAcceptedRisks[0]?.findingId).toBe("P1.1");
		if (!fresh || !continued)
			throw new Error("expected implementation context");
		const formatted = formatImplementationReviewerContext(fresh);
		expect(formatted).toBe(formatImplementationReviewerContext(continued));
		expect(formatted).not.toContain("### Closure rules");
		expect(formatted).not.toContain("--prior-finding");
		ctx.db.close();
	});

	test("a fresh session closure review carries prior-outcome rules", () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.store.saveImplementationBinding(
			binding(),
			ctx.originFor({ kind: "system", role: "cli" }),
		);
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "steps:reviewer:1",
			payload: {
				step_name: "reviewer:commit",
				phase: "1",
				iteration: 1,
				result_json: {
					readiness: "not_ready",
					items: [{ id: "I1", title: "Open", action: "auto_fix", reason: "x" }],
				},
			},
			...recordedEnvelope(TEST_ORIGIN),
		});
		const fresh = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
			sessionId: "new",
		});
		if (!fresh) throw new Error("expected closure context");
		expect(fresh.reviewKind).toBe("closure");
		expect(fresh.requiredOutcomeIds).toEqual(["I1"]);
		const rendered = formatImplementationReviewerContext(fresh);
		expect(rendered).toContain("### Closure rules");
		expect(rendered).toContain("priorFindings");
		expect(rendered).toContain("--prior-finding");
		expect(rendered).toContain("partially_addressed");
		expect(rendered).toContain("introducedBy");
		expect(rendered).toContain("priorDecisionId");
		expect(rendered).toContain("newEvidence");
		expect(rendered).toContain(
			"Do not perform another exhaustive material pass",
		);
		ctx.db.close();
	});

	test("accepted defer_accept_risk findings are not admitted author work", () => {
		const ctx = makeBudgetContext({ mode: "advisory" });
		ctx.store.saveImplementationBinding(
			binding(),
			ctx.originFor({ kind: "system", role: "cli" }),
		);
		const observation: ImplementationReviewObservationPayload = {
			kind: "implementation-review",
			version: 1,
			id: "obs-1",
			runId: "run1",
			stepKey: { stepName: "reviewer:commit", phase: "1", iteration: 1 },
			bindingId: "binding-1",
			contextId: "ctx-1",
			domain: "implementation",
			phase: "1",
			originalVerdict: {
				readiness: "not_ready",
				items: [
					{
						id: "I-defer",
						title: "Accepted latency",
						action: "human_required",
						reason: "Operator deferred this risk.",
						priority: "P2",
						scopeClass: "implementation_defect",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
					},
					{
						id: "I-keep",
						title: "Missing guard",
						action: "auto_fix",
						reason: "Restore the check.",
						priority: "P1",
						scopeClass: "implementation_defect",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
					},
				],
			},
			outcomes: [],
			route: "author_revision",
			nextAction: "author_revision",
			diagnostics: [],
			claimObservations: [],
			gateCauses: [],
			telemetry: {
				reviewCycles: 1,
				fixCycles: 0,
				reviewOriginatedCommits: 0,
				qualityReruns: 0,
				classCounts: {
					implementation_defect: 2,
					plan_defect: 0,
					scope_expansion: 0,
					pre_existing: 0,
				},
				planAmendments: 0,
				addedPaths: [],
				boundaryInventory: [],
				effortVariance: 0,
				architectureVariance: 0,
			},
			budgetInvariant: { W: 1, R: 0, B: 8, D: 0 },
			completionAuthorized: false,
			createdAt: "2026-01-02 00:00:00",
		};
		ctx.recordStore.append({
			runId: "run1",
			stream: "budget",
			idempotencyKey: "budget:implementation-review:obs-1",
			payload: encodeImplementationReviewObservationPayload(observation),
			...recordedEnvelope(TEST_ORIGIN),
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "steps:reviewer:obs-1",
			payload: {
				step_name: "reviewer:commit",
				phase: "1",
				iteration: 1,
				result_json: observation.originalVerdict,
			},
			...recordedEnvelope(TEST_ORIGIN),
		});
		const decision = createImplementationDecision({
			gateId: "gate-defer",
			observationId: "obs-1",
			bindingId: "binding-1",
			phase: "1",
			choice: "defer_accept_risk",
			findingRefs: [{ findingId: "I-defer", fingerprint: "sha256:defer" }],
			rationale: "Accepted for this phase.",
			evidence: ["Operator note"],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "steps:human:defer",
			payload: {
				step_name: "human:review-governance",
				phase: "1",
				iteration: 2,
				result_json: {
					decisionId: decision.decisionId,
					gateId: decision.gateId,
				},
			},
			...recordedEnvelope(TEST_ORIGIN),
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "decisions",
			idempotencyKey: `decision:${decision.decisionId}`,
			payload: decision,
			...recordedEnvelope(TEST_ORIGIN),
		});
		const built = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
		});
		if (!built) throw new Error("expected author context");
		expect(built.actionableFindings.map((finding) => finding.id)).toEqual([
			"I-keep",
		]);
		const author = formatImplementationAuthorContext(built);
		expect(author).toContain("I-keep");
		expect(author).toContain(
			`I-defer (Accepted latency, decision ${decision.decisionId})`,
		);
		expect(author).not.toContain("I-defer (implementation_defect");
		ctx.db.close();
	});
});

describe("implementation instruction templates", () => {
	test("documents classes, planImpact locations, and no plan score formulas", () => {
		const initial = renderTemplate("reviewer-commit", {
			commit_hash: "abc",
			review_path: "review.md",
			plan_path: "plan.md",
			review_template_path: "template.md",
		}).prompt;
		const closure = renderTemplate("reviewer-commit-continued", {
			commit_hash: "abc",
			review_path: "review.md",
			plan_path: "plan.md",
			review_template_path: "template.md",
			previous_review_commit: "old",
			current_commit: "new",
		}).prompt;
		for (const prompt of [initial, closure]) {
			expect(prompt).toContain("implementation_defect");
			expect(prompt).toContain("plan_defect");
			expect(prompt).toContain("scope_expansion");
			expect(prompt).toContain("pre_existing");
			expect(prompt).toContain('"kind": "text_only"');
			expect(prompt).toContain("staleText");
			expect(prompt).toContain("Missing or ambiguous");
			expect(prompt).toContain("Do not emit `baselineAssessment`");
			expect(prompt).not.toContain("--baseline-assessment");
			expect(prompt).not.toContain("projectedEffort");
		}
		expect(initial).toContain("one exhaustive material pass");
		expect(closure).toContain("closure review");
		expect(closure).toContain("Nonblocking follow-ups");
	});

	test("author prompts admit only governed findings and forbid cleanup", () => {
		const fix = renderTemplate("author-process-impl-review", {
			review_path: "review.md",
			plan_path: "plan.md",
			user_notes: "",
		}).prompt;
		const next = renderTemplate("author-next-phase", {
			plan_path: "plan.md",
			phase_number: "1",
			user_notes: "",
		}).prompt;
		expect(fix).toContain("Admitted implementation work");
		expect(fix).toContain("latest addendum");
		expect(fix).toContain("text guard");
		expect(fix).toContain("approved amendment workflow");
		expect(fix).toContain("only the eligible item");
		expect(fix).toContain("code implementation");
		expect(next).toContain("approved work-item IDs");
		expect(next).not.toContain("--baseline-assessment");
	});

	test("the reviewer introducedBy example passes protocol emit", async () => {
		const prompt = renderTemplate("reviewer-commit", {
			commit_hash: "abc",
			review_path: "review.md",
			plan_path: "plan.md",
			review_template_path: "template.md",
		}).prompt;
		const items = shellJsonArgs(prompt, "--item");
		expect(items).toHaveLength(2);
		const originalWrite = process.stdout.write;
		let emitted = "";
		process.stdout.write = ((chunk: string | Uint8Array) => {
			emitted += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await protocolEmitReviewer({ ready: false, item: items });
		} finally {
			process.stdout.write = originalWrite;
		}
		const verdict = JSON.parse(emitted) as {
			items: Array<{
				introducedBy?: {
					commitRange: string;
					diffHunk: string;
					explanation: string;
				};
			}>;
		};
		expect(verdict.items[0]?.introducedBy).toEqual({
			commitRange: "<base>..<reviewed>",
			diffHunk:
				"diff --git a/src/example.ts b/src/example.ts\n@@ -1,1 +1,2 @@\n-return value\n+return value ?? fallback\n",
			explanation:
				"The missing fallback was introduced in this reviewed range.",
		});
		expect(prompt).not.toContain('"path":"src/example.ts"');
	});
});

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function shellJsonArgs(prompt: string, flag: string): string[] {
	const marker = `${flag} '`;
	const found: string[] = [];
	let index = 0;
	while (index < prompt.length) {
		const start = prompt.indexOf(marker, index);
		if (start < 0) break;
		const jsonStart = start + marker.length;
		let depth = 0;
		let end = jsonStart;
		for (; end < prompt.length; end++) {
			const ch = prompt[end];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end++;
					break;
				}
			}
		}
		found.push(prompt.slice(jsonStart, end));
		index = end;
	}
	return found;
}

function structuredProvider(structured: unknown): AgentProvider {
	const result = {
		text: "structured response",
		structured,
		sessionId: "session-governance",
		tokens: { in: 0, out: 0 },
		durationMs: 0,
	};
	const session = {
		id: result.sessionId,
		run: async () => result,
		async *runStreamed() {
			yield { type: "done" as const, result };
		},
	};
	return {
		startSession: async () => session,
		resumeSession: async () => session,
		close: async () => {},
	};
}

function git(dir: string, args: string[]) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
	}
}

describe("implementation handler prompt parity", () => {
	test(
		"template render and invoke append the same implementation context and envelope fields",
		async () => {
			const dir = join(
				tmpdir(),
				`5x-impl-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(dir, { recursive: true });
			const plan = "# Plan\n";
			const ctx = makeBudgetContext({ mode: "advisory" });
			let db: Database | undefined;
			const originalLog = console.log;
			const logs: string[] = [];
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				git(dir, ["init"]);
				git(dir, ["config", "user.email", "test@test.com"]);
				git(dir, ["config", "user.name", "Test"]);
				const stateDir = join(dir, ".5x");
				mkdirSync(stateDir, { recursive: true });
				db = new Database(join(stateDir, "5x.db"));
				runMigrations(db);
				await initScaffold({ startDir: dir });
				const planPath = join(dir, "plan.md");
				writeFileSync(planPath, plan);
				createRunV1(db, { id: "run1", planPath });
				git(dir, ["add", "-A"]);
				git(dir, ["commit", "-m", "plan"]);
				const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();
				const seeded = binding();
				seeded.mode = "advisory";
				seeded.effectiveDecisions = [];
				seeded.approvedPlanBytes = plan;
				seeded.approvedPlanHash = hashPlanBytes(plan);
				seeded.ledgerHash = hashPlanBytes(stableStringify(seeded.ledger));
				seeded.decisionsHash = hashPlanBytes(
					stableStringify(seeded.effectiveDecisions),
				);
				ctx.store.saveImplementationBinding(
					seeded,
					ctx.originFor({ kind: "system", role: "cli" }),
				);
				ctx.executionContext.controlPlaneRoot = dir;
				ctx.executionContext.effectiveWorkingDirectory = dir;
				ctx.executionContext.effectivePlanPath = planPath;
				ctx.executionContext.run.plan_path = planPath;
				const templates = [
					"author-next-phase",
					"author-process-impl-review",
					"reviewer-commit",
					"reviewer-commit-continued",
				] as const;
				for (const template of templates) {
					logs.length = 0;
					let nativePrompt = "";
					let invokePrompt = "";
					const continued = template.endsWith("-continued");
					const reviewer = template.startsWith("reviewer-");
					const vars = [
						"phase_number=1",
						...(reviewer ? [`commit_hash=${head}`] : []),
					];
					await templateRender(
						{
							template,
							run: "run1",
							workdir: dir,
							vars,
							...(continued ? { session: "session-1" } : { newSession: true }),
						},
						{
							db,
							createReviewBudgetContext: async () => ctx,
							onRenderedPrompt: (prompt) => {
								nativePrompt = prompt;
							},
						},
					);
					const rendered = JSON.parse(logs.at(-1) ?? "{}") as {
						data?: {
							binding_id?: string;
							source_run_id?: string;
							pinned_mode?: string;
							pre_author_commit?: string;
							prompt?: string;
						};
					};
					expect(rendered.data?.binding_id).toBe("binding-1");
					expect(rendered.data?.source_run_id).toBe("source-run");
					expect(rendered.data?.pinned_mode).toBe("advisory");
					if (template.startsWith("author-")) {
						expect(rendered.data?.pre_author_commit).toMatch(/^[0-9a-f]{40}$/);
					}
					const author = template.startsWith("author-");
					await invokeAgent(
						author ? "author" : "reviewer",
						{
							template,
							run: "run1",
							workdir: dir,
							vars,
							phase: "1",
							quiet: true,
							...(continued ? { session: "session-1" } : { newSession: true }),
						},
						{
							db,
							createReviewBudgetContext: async () => ctx,
							createProvider: async () =>
								structuredProvider(
									author
										? {
												result: "needs_human",
												reason: "Prompt capture fixture.",
											}
										: {
												readiness: "ready",
												items: [],
												creditRealizations: [],
											},
								),
							onRenderedPrompt: (prompt) => {
								invokePrompt = prompt;
							},
						},
					);
					const marker = author
						? "## Admitted implementation work"
						: "## Implementation-review governance context";
					const slice = (prompt: string) => {
						const start = prompt.indexOf(marker);
						expect(start).toBeGreaterThanOrEqual(0);
						const contextStart = prompt.indexOf("\n\n## Context\n", start);
						return prompt.slice(
							start,
							contextStart < 0 ? undefined : contextStart,
						);
					};
					expect(slice(invokePrompt)).toBe(slice(nativePrompt));
					expect(slice(nativePrompt)).toContain("Binding: binding-1");
					expect(slice(nativePrompt)).toContain("Source run: source-run");
					expect(slice(nativePrompt)).toContain("Pinned mode: advisory");
					const invokeEnvelope = JSON.parse(
						logs.filter((line) => line.includes('"binding_id"')).at(-1) ?? "{}",
					) as {
						data?: {
							binding_id?: string;
							pinned_mode?: string;
							source_run_id?: string;
							pre_author_commit?: string;
						};
					};
					expect(invokeEnvelope.data?.binding_id).toBe("binding-1");
					expect(invokeEnvelope.data?.source_run_id).toBe("source-run");
					expect(invokeEnvelope.data?.pinned_mode).toBe("advisory");
				}
			} finally {
				console.log = originalLog;
				setTemplateOverrideDir(null);
				ctx.db.close();
				db?.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
