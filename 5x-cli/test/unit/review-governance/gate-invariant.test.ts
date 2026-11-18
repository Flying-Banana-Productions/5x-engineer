import { describe, expect, test } from "bun:test";
import {
	parseVars,
	resolveAndRenderTemplate,
} from "../../../src/commands/template-vars.js";
import type { FiveXConfig } from "../../../src/config.js";
import type { ReviewerVerdict, VerdictItem } from "../../../src/protocol.js";
import type { CodeDiffContext } from "../../../src/review-governance/code-diff.js";
import { parseCodePatch } from "../../../src/review-governance/code-diff.js";
import {
	enforcedGateInvariantViolation,
	gatelessHumanGateReport,
	isUnexplainedNegativeVerdict,
	UNEXPLAINED_NEGATIVE_VERDICT,
	unexplainedNegativeVerdictError,
} from "../../../src/review-governance/gate-invariant.js";
import { validateImplementationReview } from "../../../src/review-governance/implementation.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import {
	buildImplementationPlanEvidence,
	formatImplementationPlanEvidence,
	readPlanOnlyDiff,
} from "../../../src/review-governance/plan-evidence.js";

const BASE = "a".repeat(40);
const END = "b".repeat(40);

const PLAN = `# Plan

## Phase 1: Wire the store

**Completion gate:** The store is wired.

- Implement the store.
- Add tests.

## Phase 2: Ship

- [ ] Release
`;

const SCHEMA_1_PLAN = `<!-- 5x:plan-schema:1 -->

**Version:** 1.0

<!-- 5x:contract:start -->

# Plan

## Phase 1: Wire the store

- [ ] Implement the store

<!-- 5x:note:start id="n1" -->
Reviewer note: not governing.
<!-- 5x:note:end id="n1" -->

<!-- 5x:contract:end -->
`;

const codePatch = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");
const parsed = parseCodePatch(codePatch);
const codeContext: CodeDiffContext = {
	baseCommit: BASE,
	reviewedCommit: END,
	patch: codePatch,
	patchHash: "sha256:00",
	excludedPaths: ["docs/plan.md"],
	hunks: parsed.hunks,
	binaryPaths: [],
};

function planDefect(
	overrides: Partial<VerdictItem> & Pick<VerdictItem, "planImpact">,
): VerdictItem {
	return {
		id: "P1",
		title: "Phase 1 has no executable checklist",
		action: "human_required",
		reason: "Phase 1 cannot be checked off.",
		priority: "P1",
		scopeClass: "plan_defect",
		effortDelta: 0,
		architectureDelta: 0,
		planWorkItemIds: [],
		boundaryChanges: ["plan-structure"],
		...overrides,
	};
}

function validate(items: VerdictItem[], priorReviewCount = 1) {
	return validateImplementationReview({
		verdict: { readiness: "not_ready", items, priorFindings: [] },
		phase: "1",
		mode: "enforced",
		phaseIds: ["1", "2"],
		workItemIds: ["W1"],
		creditClaimIds: [],
		approvedPlanBytes: PLAN,
		approvedPlanHash: hashPlanBytes(PLAN),
		amendments: [],
		recordedSchema: 0,
		hasRun: true,
		priorReviewCount,
		codeContext,
		priorCodeFindings: [],
		priorCodeDecisions: [],
	});
}

describe("unexplained negative verdicts", () => {
	test("only not_ready with no items and no open prior finding is unexplained", () => {
		expect(
			isUnexplainedNegativeVerdict({ readiness: "not_ready", items: [] }),
		).toBe(true);
		expect(
			isUnexplainedNegativeVerdict({
				readiness: "not_ready",
				items: [],
				priorFindings: [{ id: "F1", status: "addressed" }],
			}),
		).toBe(true);
		expect(
			isUnexplainedNegativeVerdict({
				readiness: "not_ready",
				items: [],
				priorFindings: [{ id: "F1", status: "still_open" }],
			}),
		).toBe(false);
		expect(
			isUnexplainedNegativeVerdict({ readiness: "ready", items: [] }),
		).toBe(false);
		expect(
			isUnexplainedNegativeVerdict({
				readiness: "not_ready",
				items: [planDefect({ planImpact: { kind: "design", locations: [] } })],
			}),
		).toBe(false);
	});

	test("the repair error uses the bounded structured-output retry code and records nothing", () => {
		const error = unexplainedNegativeVerdictError("implementation");
		expect(error.code).toBe("INVALID_STRUCTURED_OUTPUT");
		expect(error.detail.reason).toBe(UNEXPLAINED_NEGATIVE_VERDICT);
		expect(error.detail.recorded).toBe(false);
		expect(error.detail.runPreserved).toBe(true);
		expect(error.message).toContain("no human gate was opened");
		expect(error.detail.retryGuidance).toContain("plan_defect");
		expect(error.detail.retryGuidance).toContain(
			"does not restart implementation",
		);
		expect(unexplainedNegativeVerdictError("plan").detail.domain).toBe("plan");
	});
});

/** Split a generated shell command, honoring the single quotes `shellArg` emits. */
function shellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quoted) {
			if (char === "'") quoted = false;
			else current += char;
		} else if (char === "'") {
			quoted = true;
			started = true;
		} else if (char === "\\" && command[i + 1] === "'") {
			current += "'";
			i++;
		} else if (/\s/u.test(char)) {
			if (started) words.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) words.push(current);
	return words;
}

const RENDER_CONFIG: Pick<FiveXConfig, "paths"> = {
	paths: {
		plans: "/project/docs/development",
		reviews: "/project/docs/development/reviews",
		archive: "/project/docs/archive",
		records: "/project/docs/development/runs",
		templates: {
			plan: "/project/.5x/templates/implementation-plan-template.md",
			review: "/project/.5x/templates/review-template.md",
		},
	},
};

/**
 * Resolve a generated `5x template render` or `5x invoke` command through the
 * same shared template resolution both handlers use, with the CLI-derived
 * run, plan and path context. Throws when a required variable is missing.
 */
async function resolveGeneratedCommand(command: string) {
	const words = shellWords(command);
	const native = words[1] === "template" && words[2] === "render";
	const invoke = words[1] === "invoke";
	if (!native && !invoke) throw new Error(`not a delegation: ${command}`);
	const templateName = words[3] as string;
	const vars: string[] = [];
	let run: string | undefined;
	let phase: string | undefined;
	let newSession = false;
	for (let i = 4; i < words.length; i++) {
		const word = words[i];
		if (word === "--var") vars.push(words[++i] as string);
		else if (word === "--run") run = words[++i];
		else if (word === "--phase") phase = words[++i];
		else if (word === "--new-session") newSession = true;
		else if (word === "--session") throw new Error("unexpected --session");
	}
	const explicitVars = await parseVars(vars);
	return resolveAndRenderTemplate({
		templateName,
		newSession,
		explicitVars,
		resolvedPlanPath: "/project/docs/development/plan.md",
		config: RENDER_CONFIG,
		projectRoot: "/project",
		runId: run,
		phase: native
			? explicitVars.phase_number
			: (phase ?? explicitVars.phase_number),
	});
}

describe("enforced gate invariant", () => {
	test("an enforced human_gate needs a cause; advisory and off are unchecked", () => {
		expect(
			enforcedGateInvariantViolation({
				domain: "implementation",
				mode: "enforced",
				route: "human_gate",
				causeCount: 0,
			}),
		).toContain("REVIEW_GATE_INVARIANT");
		expect(
			enforcedGateInvariantViolation({
				domain: "plan",
				mode: "enforced",
				route: "human_gate",
				causeCount: 1,
			}),
		).toBeNull();
		for (const mode of ["advisory", "off"] as const) {
			expect(
				enforcedGateInvariantViolation({
					domain: "implementation",
					mode,
					route: "human_gate",
					causeCount: 0,
				}),
			).toBeNull();
		}
		expect(
			enforcedGateInvariantViolation({
				domain: "implementation",
				mode: "enforced",
				route: "author_revision",
				causeCount: 0,
			}),
		).toBeNull();
	});

	test("a gate-less report orders direct repair before the same-run corrective review", () => {
		const drifted = gatelessHumanGateReport({
			domain: "implementation",
			runId: "run1",
			phase: "1",
			recordId: "obs-1",
			nextAction: "human_gate",
			planDrifted: true,
			stepName: "reviewer:commit",
			nextIteration: 3,
		});
		expect(drifted.next[0]).toBe(
			"5x plan repair-checklists --run run1 --dry-run",
		);
		expect(drifted.next[1]).toContain("--apply --reason");
		expect(drifted.next.slice(2).join("\n")).toContain(
			"5x template render reviewer-commit --run run1 --var phase_number=1",
		);
		expect(drifted.next.join("\n")).toContain("--iteration 3");
		expect(drifted.next.join("\n")).not.toContain("review decide");
		expect(drifted.remediation).toContain("No gate decision, new run");
		const clean = gatelessHumanGateReport({
			domain: "plan",
			runId: "run1",
			phase: "plan",
			recordId: "snap-1",
			nextAction: "human_gate",
			planDrifted: false,
		});
		expect(clean.next[0]).toContain(
			"5x template render reviewer-plan --run run1",
		);
		expect(clean.next.join("\n")).not.toContain("repair-checklists");
	});
	test("generated implementation recovery commands resolve the real reviewer template in native and invoke modes", async () => {
		const report = gatelessHumanGateReport({
			domain: "implementation",
			runId: "run1",
			phase: "1",
			recordId: "obs-1",
			nextAction: "human_gate",
			planDrifted: false,
			stepName: "reviewer:commit",
			nextIteration: 2,
			reviewedCommit: END,
			contextId: "ctx-1",
		});
		const native = report.next.find((command) =>
			command.startsWith("5x template render "),
		);
		const invoke = report.next.find((command) =>
			command.startsWith("5x invoke "),
		);
		if (!native || !invoke) throw new Error("expected both delegation paths");
		for (const command of [native, invoke]) {
			const resolved = await resolveGeneratedCommand(command);
			expect(resolved.selectedTemplateName).toBe("reviewer-commit");
			expect(resolved.variables).toMatchObject({
				commit_hash: END,
				phase_number: "1",
				run_id: "run1",
				review_path: "/project/docs/development/reviews/run1-phase-1-review.md",
			});
			expect(resolved.prompt).toContain(`Commit to review: ${END}`);
			expect(resolved.stepName).toBe("reviewer:commit");
		}
		expect(invoke).toContain(
			"--record-step reviewer:commit --phase 1 --iteration 2",
		);

		// The same resolution rejects a delegation without the durable commit,
		// so the check above exercises the template's required inputs.
		await expect(
			resolveGeneratedCommand(native.replace(` --var commit_hash=${END}`, "")),
		).rejects.toThrow("missing required variables: commit_hash");
	});
});

describe("plan evidence beside code evidence", () => {
	test("anchors the governing phase text, diagnostics and the run repair command", () => {
		const evidence = buildImplementationPlanEvidence({
			runId: "run1",
			phaseId: "1",
			approvedPlanBytes: PLAN,
			approvedPlanHash: hashPlanBytes(PLAN),
			revisionId: "rev-1",
			schema: 0,
			planRepoPath: "docs/plan.md",
			reviewRange: { baseCommit: BASE, reviewedCommit: END },
			workdir: "/repo",
		});
		expect(evidence.phase).toMatchObject({
			id: "1",
			heading: "## Phase 1: Wire the store",
			startLine: 3,
		});
		expect(evidence.phase?.text).toContain("- Implement the store.");
		expect(evidence.phase?.text).not.toContain("Release");
		expect(evidence.diagnostics.map((entry) => entry.code)).toContain(
			"PLAN_PHASE_NO_CHECKLIST",
		);
		expect(evidence.diagnostics.every((entry) => entry.phase !== "2")).toBe(
			true,
		);
		expect(evidence.repairCommands[0]).toContain(
			"5x plan repair-checklists --run run1",
		);
		expect(evidence.planOnlyDiff).toBeNull();
		expect(evidence.planOnlyDiffRetrieval).toContain(`${BASE}..${END}`);
		expect(evidence.planOnlyDiffRetrieval).toContain(
			":(literal,top)docs/plan.md",
		);
		const rendered = formatImplementationPlanEvidence(evidence);
		expect(rendered).toContain("### Plan evidence");
		expect(rendered).toContain(
			`Effective approved plan hash: ${hashPlanBytes(PLAN)}`,
		);
		expect(rendered).toContain("approved plan lines 3–");
		expect(rendered).toContain("needs no code hunk");
		expect(rendered).toContain("no plan-only changes in the reviewed range");
	});

	test("schema 1 notes cannot appear as governing evidence", () => {
		const evidence = buildImplementationPlanEvidence({
			runId: "run1",
			phaseId: "1",
			approvedPlanBytes: SCHEMA_1_PLAN,
			approvedPlanHash: hashPlanBytes(SCHEMA_1_PLAN),
			revisionId: "rev-1",
			schema: 1,
		});
		expect(evidence.phase?.text).toContain("- [ ] Implement the store");
		expect(evidence.phase?.text).not.toContain("Reviewer note");
		expect(evidence.diagnostics).toEqual([]);
		expect(evidence.repairCommands).toEqual([]);
		expect(evidence.planOnlyDiffRetrieval).toBeNull();
	});

	test("reads a plan-only diff without touching the code range", async () => {
		const calls: string[][] = [];
		const planDiff =
			"diff --git a/docs/plan.md b/docs/plan.md\n@@ -5 +5 @@\n-- x\n+- [ ] x\n";
		const git = {
			async exec(args: string[]) {
				calls.push(args);
				return { stdout: planDiff, stderr: "", exitCode: 0 };
			},
		};
		const diff = await readPlanOnlyDiff({
			git,
			baseCommit: BASE,
			reviewedCommit: END,
			planRepoPath: "docs/plan.md",
		});
		expect(diff).toMatchObject({ path: "docs/plan.md", truncatedLines: 0 });
		expect(diff?.diff).toContain("+- [ ] x");
		expect(calls[0]?.at(-1)).toBe(":(literal,top)docs/plan.md");
		expect(calls[0]).toContain(`${BASE}..${END}`);
		const evidence = buildImplementationPlanEvidence({
			runId: "run1",
			phaseId: "1",
			approvedPlanBytes: PLAN,
			approvedPlanHash: hashPlanBytes(PLAN),
			revisionId: "rev-1",
			schema: 0,
			planOnlyDiff: diff,
		});
		expect(formatImplementationPlanEvidence(evidence)).toContain("+- [ ] x");
		expect(codeContext.patch).not.toContain("docs/plan.md");

		const empty = await readPlanOnlyDiff({
			git: {
				async exec() {
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
			baseCommit: BASE,
			reviewedCommit: END,
			planRepoPath: "docs/plan.md",
		});
		expect(empty).toBeNull();
		expect(
			await readPlanOnlyDiff({
				git,
				baseCommit: BASE,
				reviewedCommit: END,
				planRepoPath: null,
			}),
		).toBeNull();
	});
});

describe("structural plan defects need no code hunk", () => {
	test("an unchanged approved-plan defect is accepted in a continued review and routes to amendment", () => {
		const result = validate([
			planDefect({
				planImpact: {
					kind: "design",
					locations: [
						{
							heading: "Phase 1: Wire the store",
							staleText: "- Implement the store.",
						},
					],
				},
			}),
		]);
		expect(result.valid).toBe(true);
		expect(result.accepted).toBe(true);
		expect(result.governance?.route).toBe("human_gate");
		expect(result.governance?.nextAction).toBe("plan_amendment");
		expect(result.diagnostics.map((entry) => entry.code)).not.toContain(
			"NEW_FINDING_EVIDENCE_REQUIRED",
		);
		expect(result.diagnostics.map((entry) => entry.code)).not.toContain(
			"PLAN_EVIDENCE_ANCHOR_MISMATCH",
		);
	});

	test("existing formats stay valid: empty design locations and authorized text-only spans", () => {
		const design = validate([
			planDefect({ planImpact: { kind: "design", locations: [] } }),
		]);
		expect(design.valid).toBe(true);
		expect(design.diagnostics).toEqual([]);
		const textOnly = validate([
			planDefect({
				action: "auto_fix",
				boundaryChanges: [],
				planImpact: {
					kind: "text_only",
					locations: [
						{
							heading: "Phase 1: Wire the store",
							staleText: "The store is wired.",
						},
					],
				},
			}),
		]);
		expect(textOnly.fatalMessage).toBeUndefined();
		expect(textOnly.valid).toBe(true);
		expect(textOnly.exemptionAuthorized).toBe(true);
		expect(textOnly.governance?.route).toBe("author_revision");
	});

	test("incorrect anchors are reported, not silently accepted or turned into a new blocker", () => {
		const design = validate([
			planDefect({
				planImpact: {
					kind: "design",
					locations: [{ heading: "Phase 9: Missing", staleText: "anything" }],
				},
			}),
		]);
		expect(design.valid).toBe(true);
		expect(design.governance?.nextAction).toBe("plan_amendment");
		expect(design.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PLAN_EVIDENCE_ANCHOR_MISMATCH",
				itemId: "P1",
			}),
		);
		const stale = validate([
			planDefect({
				planImpact: {
					kind: "budget",
					locations: [
						{ heading: "Phase 1: Wire the store", staleText: "not there" },
					],
				},
			}),
		]);
		expect(stale.diagnostics.map((entry) => entry.code)).toContain(
			"PLAN_EVIDENCE_ANCHOR_MISMATCH",
		);
		const textOnly = validate([
			planDefect({
				action: "auto_fix",
				boundaryChanges: [],
				planImpact: {
					kind: "text_only",
					locations: [{ heading: "Phase 2: Ship", staleText: "Rollback" }],
				},
			}),
		]);
		expect(textOnly.exemptionAuthorized).toBe(false);
		expect(textOnly.diagnostics.map((entry) => entry.code)).toContain(
			"PLAN_IMPACT_AMBIGUOUS",
		);
		expect(textOnly.governance?.nextAction).toBe("plan_amendment");
	});

	test("ordinary code blockers still need exact code evidence", () => {
		const verdict: ReviewerVerdict["items"] = [
			{
				id: "I1",
				title: "Dropped status",
				action: "auto_fix",
				reason: "The write path ignores failure.",
				priority: "P1",
				scopeClass: "implementation_defect",
				effortDelta: 1,
				architectureDelta: 0,
				planWorkItemIds: ["W1"],
			},
		];
		const missing = validate(verdict);
		expect(missing.valid).toBe(false);
		expect(missing.fatalCode).toBe("NEW_FINDING_EVIDENCE_REQUIRED");
		const cited = validate([
			{
				...(verdict[0] as VerdictItem),
				introducedBy: {
					commitRange: `${BASE}..${END}`,
					diffHunk: parsed.hunks[0]?.text ?? "",
					explanation: "The new line drops the status.",
				},
			},
		]);
		expect(cited.valid).toBe(true);
		expect(cited.governance?.route).toBe("author_revision");
	});
});
