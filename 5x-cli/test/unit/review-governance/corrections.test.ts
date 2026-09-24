import { describe, expect, test } from "bun:test";
import { isPreReviewQualityCache } from "../../../src/commands/phase.handler.js";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import {
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import type { ReviewerVerdict } from "../../../src/protocol.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationClaimObservation,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import type { CodeDiffGit } from "../../../src/review-governance/code-diff.js";
import {
	assessCorrectionInventory,
	type CorrectionQualityResult,
	carryOriginatingClaims,
	evaluateImplementationCorrectionEligibility,
	finishImplementationCorrection,
	qualityConfigDigest,
} from "../../../src/review-governance/corrections.js";
import { validateFinalCorrections } from "../../../src/review-governance/routing.js";

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "system", role: "cli" },
};
const RUN = "run_corr001";
const REVIEWED = "b".repeat(40);
const COMMIT = "a".repeat(40);
const TREE = "c".repeat(40);
const OTHER = "d".repeat(40);
const OTHER_TREE = "e".repeat(40);

function item(
	overrides: Partial<ReviewerVerdict["items"][number]> = {},
): ReviewerVerdict["items"][number] {
	return {
		id: "R1",
		title: "Off-by-one",
		action: "auto_fix",
		reason: "The loop stops one short.",
		scopeClass: "implementation_defect",
		priority: "P2",
		effortDelta: 5,
		architectureDelta: 0,
		boundaryChanges: [],
		mechanicalExplanation: "Change the comparison operator.",
		planWorkItemIds: ["W1"],
		...overrides,
	};
}

function verdict(items: ReviewerVerdict["items"]): ReviewerVerdict {
	return { readiness: "ready_with_corrections", items };
}

const CLAIMS: ImplementationClaimObservation[] = [
	{
		creditClaimId: "DC0",
		realization: "partial",
		realizedArchitectureDelta: -1,
		evidence: "The binding exists but a second writer remains.",
	},
];

function observation(
	overrides: Partial<ImplementationReviewObservationPayload> = {},
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId: RUN,
		stepKey: { stepName: "reviewer:review", phase: "6", iteration: 0 },
		bindingId: "bind-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: "6",
		originalVerdict: verdict([item()]),
		outcomes: [],
		route: "author_revision",
		nextAction: "author_revision",
		diagnostics: [],
		claimObservations: CLAIMS,
		gateCauses: [],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 1,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 5,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 5, R: 0, B: 5, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-09-23 00:00:01",
		...overrides,
	};
}

function context(
	overrides: Partial<ImplementationReviewContextPayload> = {},
): ImplementationReviewContextPayload {
	return {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-1",
		executionRunId: RUN,
		bindingId: "bind-1",
		phase: "6",
		baseCommit: "f".repeat(40),
		reviewedCommit: REVIEWED,
		patchHash: "sha256:abc",
		excludedPaths: [".5x/"],
		hunks: [
			{
				oldPath: "src/fix.ts",
				newPath: "src/fix.ts",
				header: "@@ -1 +1 @@",
				text: "diff --git a/src/fix.ts b/src/fix.ts\n@@ -1 +1 @@\n-a\n+b\n",
				hash: "sha256:hunk",
			},
		],
		binaryPaths: [],
		createdAt: "2026-09-23 00:00:00",
		...overrides,
	};
}

function fakeGit(options?: {
	head?: string;
	tree?: string;
	paths?: string;
	dirtyAt?: number;
	ancestor?: boolean;
}): CodeDiffGit {
	let statusCalls = 0;
	return {
		async exec(args) {
			const text = args.join(" ");
			if (text.startsWith("status")) {
				statusCalls += 1;
				if (options?.dirtyAt !== undefined && statusCalls >= options.dirtyAt) {
					return {
						stdout: " M src/fix.ts\n",
						stderr: "",
						exitCode: 0,
					};
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			if (text.includes("rev-parse --verify")) {
				const spec = args.at(-1) ?? "";
				const sha = spec.startsWith("HEAD")
					? (options?.head ?? COMMIT)
					: spec.slice(0, 40);
				return { stdout: `${sha}\n`, stderr: "", exitCode: 0 };
			}
			if (text.includes("^{tree}")) {
				const spec = args.at(-1) ?? "";
				const tree = spec.startsWith(OTHER)
					? OTHER_TREE
					: (options?.tree ?? TREE);
				return { stdout: `${tree}\n`, stderr: "", exitCode: 0 };
			}
			if (text.includes("merge-base")) {
				return {
					stdout: "",
					stderr: "",
					exitCode: options?.ancestor === false ? 1 : 0,
				};
			}
			if (text.includes("--name-status")) {
				return {
					stdout: options?.paths ?? "M\tsrc/fix.ts\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "", stderr: `unexpected ${text}`, exitCode: 1 };
		},
	};
}

function setup(obs = observation(), ctx = context()) {
	const recordStore = createMemoryRecordStore();
	recordStore.putRun({
		id: RUN,
		plan_path: "docs/plan.md",
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
	const store = createReviewBudgetStore(recordStore);
	recordStore.append({
		runId: RUN,
		stream: "budget",
		idempotencyKey: implementationReviewObservationKey(RUN, obs.stepKey),
		payload: encodeImplementationReviewObservationPayload(obs),
		createdAt: obs.createdAt,
		...recordedEnvelope(ORIGIN),
	});
	store.saveImplementationReviewContext(ctx, ORIGIN);
	const recordAuthor = (commit: string, iteration: number) => {
		recordStore.append({
			runId: RUN,
			stream: "steps",
			idempotencyKey: stepIdempotencyKey({
				runId: RUN,
				stepName: "author:impl",
				phase: "6",
				iteration,
			}),
			payload: {
				step_name: "author:impl",
				phase: "6",
				iteration,
				result_json: { result: "complete", commit },
				head_commit: commit,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			createdAt: "2026-09-23 00:00:02",
			...recordedEnvelope(ORIGIN),
		});
	};
	recordAuthor(COMMIT, 1);
	recordAuthor(OTHER, 2);
	recordStore.append({
		runId: RUN,
		stream: "steps",
		idempotencyKey: stepIdempotencyKey({
			runId: RUN,
			stepName: "quality:check",
			phase: "6",
			iteration: 1,
		}),
		payload: {
			step_name: "quality:check",
			phase: "6",
			iteration: 1,
			result_json: { passed: true, results: [] },
			head_commit: COMMIT,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		createdAt: "2026-09-23 00:00:01",
		...recordedEnvelope(ORIGIN),
	});
	return { recordStore, store };
}

function passingQuality(workdir = "/repo"): CorrectionQualityResult {
	return {
		passed: true,
		results: [
			{ command: "bun test", passed: true, duration_ms: 4, output: "ok" },
		],
		workdir,
	};
}

describe("implementation correction eligibility", () => {
	test("accepts one mechanical P2 without the plan effort ceiling", () => {
		const result = evaluateImplementationCorrectionEligibility(
			verdict([item()]),
		);
		expect(result.status).toBe("eligible");
		expect(
			validateFinalCorrections({
				items: [item()],
				projectedEffort: 1,
				effectiveCeiling: 2,
			}).valid,
		).toBe(false);
	});

	test("empty items are ordinary ready", () => {
		expect(
			evaluateImplementationCorrectionEligibility({
				readiness: "ready",
				items: [],
			}).status,
		).toBe("ready");
	});

	test("two P2s, a P1, a human item, a plan defect, and unknown boundaries stay ordinary", () => {
		expect(
			evaluateImplementationCorrectionEligibility(
				verdict([item(), item({ id: "R2" })]),
			).status,
		).toBe("ordinary");
		expect(
			evaluateImplementationCorrectionEligibility(
				verdict([item({ priority: "P1" })]),
			).route,
		).toBe("author_revision");
		expect(
			evaluateImplementationCorrectionEligibility(
				verdict([item({ action: "human_required" })]),
			).route,
		).toBe("human_gate");
		expect(
			evaluateImplementationCorrectionEligibility(
				verdict([
					item({
						scopeClass: "plan_defect",
						planImpact: { kind: "design", locations: [] },
						planWorkItemIds: undefined,
						boundaryChanges: undefined,
						mechanicalExplanation: undefined,
					}),
				]),
			).nextAction,
		).toBe("plan_amendment");
		expect(
			evaluateImplementationCorrectionEligibility(
				verdict([item({ boundaryChanges: undefined })]),
			).reason,
		).toBe("unknown_boundary");
	});
});

describe("correction inventory and claim carry-forward", () => {
	test("confines a clean fix and flags schema, plan, and uncertain paths", () => {
		expect(
			assessCorrectionInventory({
				changedPaths: ["src/fix.ts"],
				reviewedPaths: ["src/fix.ts"],
				planRepoPath: "docs/plan.md",
			}).inventoryClean,
		).toBe(true);
		const schema = assessCorrectionInventory({
			changedPaths: ["src/schema.sql"],
			reviewedPaths: ["src/schema.sql"],
			planRepoPath: "docs/plan.md",
		});
		expect(schema.boundaryChanges).toContain("schema");
		expect(schema.inventoryClean).toBe(false);
		const extra = assessCorrectionInventory({
			changedPaths: ["src/other.ts"],
			reviewedPaths: ["src/fix.ts"],
			planRepoPath: null,
		});
		expect(extra.boundaryUncertain).toBe(true);
		expect(
			carryOriginatingClaims({ claims: CLAIMS, proof: true })[0]?.realization,
		).toBe("partial");
		expect(carryOriginatingClaims({ claims: CLAIMS, proof: false })).toEqual(
			[],
		);
	});

	test("quality digest includes the full command list and directory", () => {
		const root = qualityConfigDigest({
			gates: ["bun test"],
			skipQualityGates: false,
			executionDirectory: "/repo",
		});
		const layered = qualityConfigDigest({
			gates: ["bun test packages/api"],
			skipQualityGates: false,
			executionDirectory: "/repo/packages/api",
		});
		expect(root).not.toBe(layered);
	});
});

describe("finishImplementationCorrection", () => {
	test("a fresh passing suite carries claims and a later identical call resumes", async () => {
		const { store, recordStore } = setup();
		let calls = 0;
		const first = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				calls += 1;
				return passingQuality();
			},
		});
		expect(first.status).toBe("complete");
		if (first.status !== "complete") return;
		expect(first.resumed).toBe(false);
		expect(first.attempt.architectureDelta).toBe(0);
		expect(first.attempt.boundaryChanges).toEqual([]);
		expect(first.attempt.inventoryClean).toBe(true);
		expect(first.attempt.assessedCommit).toBe(REVIEWED);
		expect(first.attempt.destinationCommit).toBe(COMMIT);
		expect(first.carriedClaims).toEqual(CLAIMS);
		expect(calls).toBe(1);
		const second = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				calls += 1;
				return passingQuality();
			},
		});
		expect(second.status).toBe("complete");
		if (second.status === "complete") expect(second.resumed).toBe(true);
		expect(calls).toBe(1);
	});

	test("stale pre-review quality is not proof", async () => {
		const { store, recordStore } = setup();
		let calls = 0;
		const result = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				calls += 1;
				return passingQuality();
			},
		});
		expect(result.status).toBe("complete");
		expect(calls).toBe(1);
		expect(isPreReviewQualityCache("quality:check", '{"passed":true}')).toBe(
			true,
		);
		expect(
			isPreReviewQualityCache("author:impl", '{"passed":true,"skipped":true}'),
		).toBe(false);
	});

	test("a different commit is new evidence and cannot resume the old proof", async () => {
		const { store, recordStore } = setup();
		await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => passingQuality(),
		});
		const next = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: OTHER,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit({ head: OTHER }),
			runQuality: async () => passingQuality(),
		});
		expect(next.status).toBe("reentry");
		if (next.status === "reentry") expect(next.reason).toBe("new_evidence");
	});

	test("failure then pass still requires reviewer re-entry", async () => {
		const { store, recordStore } = setup();
		let pass = false;
		const fail = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => ({
				passed: false,
				results: [
					{ command: "bun test", passed: false, duration_ms: 3, output: "no" },
				],
				workdir: "/repo",
			}),
		});
		expect(fail.status).toBe("reentry");
		pass = true;
		const again = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				expect(pass).toBe(true);
				return passingQuality();
			},
		});
		expect(again.status).toBe("reentry");
		if (again.status === "reentry") {
			expect(again.reason).toBe("shortcut_invalidated");
			expect(again.attempt?.carriedClaims).toEqual([]);
			expect(again.attempt?.shortcutInvalidated).toBe(true);
		}
	});

	test("timeout, empty config, skip, wrong workdir, and dirty trees do not grant the shortcut", async () => {
		const cases: Array<{
			name: string;
			gates?: string[];
			skip?: boolean;
			dirtyAt?: number;
			quality?: () => Promise<CorrectionQualityResult>;
			code?: string;
			reason?: string;
		}> = [
			{
				name: "timeout",
				quality: async () => ({
					passed: false,
					results: [
						{
							command: "bun test",
							passed: false,
							duration_ms: 9,
							output: "[TIMEOUT] Command timed out",
						},
					],
					workdir: "/repo",
				}),
				reason: "quality_timeout",
			},
			{ name: "empty", gates: [], reason: "quality_skipped" },
			{ name: "skip", skip: true, reason: "quality_skipped" },
			{
				name: "workdir",
				quality: async () => passingQuality("/elsewhere"),
				reason: "wrong_workdir",
			},
			{ name: "dirty-before", dirtyAt: 1, code: "CORRECTION_DIRTY_TREE" },
			{ name: "dirty-after", dirtyAt: 2, reason: "dirty_tree" },
		];
		for (const entry of cases) {
			const { store, recordStore } = setup(
				observation({ id: `obs-${entry.name}` }),
				context(),
			);
			const result = await finishImplementationCorrection({
				runId: RUN,
				phase: "6",
				observationId: `obs-${entry.name}`,
				commit: COMMIT,
				store,
				recordStore,
				origin: ORIGIN,
				executionDirectory:
					entry.name === "layered" ? "/repo/packages/api" : "/repo",
				planRepoPath: "docs/plan.md",
				gates: entry.gates ?? ["bun test"],
				skipQualityGates: entry.skip === true,
				git: fakeGit({ dirtyAt: entry.dirtyAt }),
				runQuality: entry.quality ?? (async () => passingQuality()),
			});
			if (entry.code) {
				expect(result.status).toBe("error");
				if (result.status === "error") expect(result.code).toBe(entry.code);
				expect(store.listImplementationCorrectionAttempts(RUN)).toHaveLength(0);
			} else {
				expect(result.status).toBe("reentry");
				if (result.status === "reentry") {
					expect(result.reason).toBe(entry.reason ?? "");
				}
			}
		}
	});

	test("a crash before a result reruns the full suite", async () => {
		const { store, recordStore } = setup();
		let calls = 0;
		const crashed = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				calls += 1;
				throw new Error("runner crashed");
			},
		});
		expect(crashed.status).toBe("reentry");
		expect(store.listImplementationCorrectionAttempts(RUN)).toHaveLength(0);
		const retried = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo/packages/api",
			planRepoPath: "docs/plan.md",
			gates: ["bun test packages/api"],
			skipQualityGates: false,
			git: fakeGit(),
			runQuality: async () => {
				calls += 1;
				return passingQuality("/repo/packages/api");
			},
		});
		expect(retried.status).toBe("complete");
		if (retried.status === "complete") {
			expect(retried.attempt.executionDirectory).toBe("/repo/packages/api");
			expect(retried.attempt.qualityRerun).toBe(1);
		}
		expect(calls).toBe(2);
	});

	test("boundary drift cannot carry assessments", async () => {
		const { store, recordStore } = setup();
		const result = await finishImplementationCorrection({
			runId: RUN,
			phase: "6",
			observationId: "obs-1",
			commit: COMMIT,
			store,
			recordStore,
			origin: ORIGIN,
			executionDirectory: "/repo",
			planRepoPath: "docs/plan.md",
			gates: ["bun test"],
			skipQualityGates: false,
			git: fakeGit({ paths: "M\tsrc/index.ts\n" }),
			runQuality: async () => passingQuality(),
		});
		expect(result.status).toBe("reentry");
		if (result.status === "reentry") {
			expect(result.reason).toBe("boundary_uncertain");
			expect(result.attempt?.carriedClaims).toEqual([]);
		}
	});
});
