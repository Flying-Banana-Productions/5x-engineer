import { describe, expect, test } from "bun:test";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import type { RecordOrigin } from "../../../src/control-plane/record-types.js";
import { RUN_RECORD_FORMAT_VERSION } from "../../../src/control-plane/record-types.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import type { CodeDiffGit } from "../../../src/review-governance/code-diff.js";
import {
	formatCodeReviewDiff,
	parseCodePatch,
	validateCodeHunkEvidence,
	validateCodeReviewClosure,
} from "../../../src/review-governance/code-diff.js";
import { createReviewDecision } from "../../../src/review-governance/decisions.js";
import {
	readImplementationCodeClosure,
	validateImplementationReview,
} from "../../../src/review-governance/implementation.js";
import {
	capturePhaseAuthorAdmission,
	PRE_AUTHOR_STEP_NAME,
	prepareImplementationReviewContext,
	readPhaseAuthorAdmission,
	verifyImplementationReviewContext,
} from "../../../src/review-governance/implementation-state.js";

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "system", role: "cli" },
};

const BASE = "a".repeat(40);
const MID = "b".repeat(40);
const END = "c".repeat(40);
const REVIEW = "d".repeat(40);
const OTHER = "e".repeat(40);

function patch(
	files: Array<{ path: string; from: string; to: string }>,
): string {
	return files
		.map(
			(file) =>
				`${[
					`diff --git a/${file.path} b/${file.path}`,
					"index 1111111..2222222 100644",
					`--- a/${file.path}`,
					`+++ b/${file.path}`,
					"@@ -1 +1 @@",
					`-${file.from}`,
					`+${file.to}`,
				].join("\n")}\n`,
		)
		.join("");
}

function fakeGit(input?: {
	patch?: string;
	dirty?: string;
	nameStatus?: string;
	head?: string;
	parents?: Record<string, string[]>;
	missing?: string[];
	ancestor?: (ancestor: string, commit: string) => boolean;
}): CodeDiffGit & { ranges: string[] } {
	const ranges: string[] = [];
	const parents = input?.parents ?? {
		[MID]: [BASE],
		[END]: [MID],
		[REVIEW]: [END],
	};
	const ancestor =
		input?.ancestor ??
		((maybe: string, commit: string) => {
			const order = [BASE, MID, END, REVIEW, OTHER];
			return (
				order.indexOf(maybe) !== -1 &&
				order.indexOf(maybe) <= order.indexOf(commit)
			);
		});
	return {
		ranges,
		async exec(args) {
			const text = args.join(" ");
			if (text.startsWith("status ")) {
				return { stdout: input?.dirty ?? "", stderr: "", exitCode: 0 };
			}
			if (text.includes("rev-parse")) {
				const spec = args.find((arg) => arg.includes("^{commit}")) ?? "";
				const named = spec.replace(/\^\{commit\}$/u, "");
				const commit = named === "HEAD" ? (input?.head ?? END) : named;
				if (input?.missing?.includes(commit)) {
					return { stdout: "", stderr: `bad ref ${commit}`, exitCode: 1 };
				}
				if (!/^[0-9a-f]{40}$/u.test(commit)) {
					return { stdout: "", stderr: "bad ref", exitCode: 1 };
				}
				return { stdout: `${commit}\n`, stderr: "", exitCode: 0 };
			}
			if (text.includes("rev-list")) {
				const commit = args.at(-1) ?? "";
				const line = [commit, ...(parents[commit] ?? [])].join(" ");
				return { stdout: `${line}\n`, stderr: "", exitCode: 0 };
			}
			if (text.includes("merge-base")) {
				const ok = ancestor(args[2] ?? "", args[3] ?? "");
				return { stdout: "", stderr: "", exitCode: ok ? 0 : 1 };
			}
			if (text.includes("--name-status")) {
				const range = args.find((arg) => arg.includes("..")) ?? "";
				ranges.push(range);
				const to = range.split("..").at(-1) ?? "";
				const stdout =
					input?.nameStatus ?? (to === REVIEW ? "" : "M\tsrc/a.ts\n");
				return { stdout, stderr: "", exitCode: 0 };
			}
			if (args.includes("diff")) {
				const range = args.find((arg) => arg.includes("..")) ?? "";
				ranges.push(range);
				return {
					stdout:
						input?.patch ??
						patch([{ path: "src/a.ts", from: "old", to: "new" }]),
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "", stderr: `unexpected git ${text}`, exitCode: 1 };
		},
	};
}

function setup() {
	const recordStore = createMemoryRecordStore();
	recordStore.putRun({
		id: "run1",
		plan_path: "docs/development/plans/gov.md",
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
	return { recordStore, store: createReviewBudgetStore(recordStore) };
}

function step(
	recordStore: ReturnType<typeof createMemoryRecordStore>,
	stepName: string,
	iteration: number,
	head: string | null,
	result: unknown = {},
) {
	recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: `step:run1:${stepName}:1:${iteration}`,
		payload: {
			step_name: stepName,
			phase: "1",
			iteration,
			result_json: result,
			head_commit: head,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		createdAt: "2026-09-23 00:00:00",
		schemaVersion: 1,
		provenance: "recorded",
		origin: ORIGIN,
	});
}

describe("code diff hunks", () => {
	test("keeps file identity for identical hunks, renames, deletes, and CRLF", () => {
		const crlf =
			"diff --git a/src/a.ts b/src/a.ts\r\n@@ -1 +1 @@\r\n-old \r\n+new\r\n";
		const parsedCrlf = parseCodePatch(crlf);
		expect(parsedCrlf.hunks[0]?.text).toContain("\r\n");
		expect(parsedCrlf.hunks[0]?.text).toContain("-old \r");

		const renamed = parseCodePatch(
			`${[
				"diff --git a/src/old.ts b/src/new.ts",
				"similarity index 100%",
				"rename from src/old.ts",
				"rename to src/new.ts",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\n")}\n`,
		);
		expect(renamed.hunks[0]).toMatchObject({
			oldPath: "src/old.ts",
			newPath: "src/new.ts",
		});

		const deleted = parseCodePatch(
			`${[
				"diff --git a/src/gone.ts b/src/gone.ts",
				"deleted file mode 100644",
				"--- a/src/gone.ts",
				"+++ /dev/null",
				"@@ -1 +0,0 @@",
				"-old",
			].join("\n")}\n`,
		);
		expect(deleted.hunks[0]).toMatchObject({
			oldPath: "src/gone.ts",
			newPath: "/dev/null",
		});

		const same = parseCodePatch(
			patch([
				{ path: "src/a.ts", from: "old", to: "new" },
				{ path: "src/b.ts", from: "old", to: "new" },
			]),
		);
		expect(same.hunks).toHaveLength(2);
		expect(same.hunks[0]?.hash).not.toBe(same.hunks[1]?.hash);
		const context = {
			baseCommit: BASE,
			reviewedCommit: END,
			patch: "",
			patchHash: "sha256:00",
			excludedPaths: [],
			hunks: same.hunks,
			binaryPaths: [],
		};
		const swapped = (same.hunks[0]?.text ?? "").replace(
			"diff --git a/src/a.ts b/src/a.ts",
			"diff --git a/src/missing.ts b/src/missing.ts",
		);
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: swapped,
					explanation: "The second file changed.",
				},
				context,
			),
		).toMatchObject({ valid: false, code: "CODE_HUNK_WRONG_FILE" });
	});

	test("rejects context-only, binary, combined, whitespace, stale, and assembled hunks", () => {
		const parsed = parseCodePatch(
			patch([{ path: "src/a.ts", from: "old", to: "new " }]),
		);
		const context = {
			baseCommit: BASE,
			reviewedCommit: END,
			patch: "",
			patchHash: "sha256:00",
			excludedPaths: [],
			hunks: parsed.hunks,
			binaryPaths: ["src/bin.dat"],
		};
		const exact = parsed.hunks[0]?.text ?? "";
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: exact,
					explanation: "The assignment changed.",
				},
				context,
			).valid,
		).toBe(true);
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${REVIEW}`,
					diffHunk: exact,
					explanation: "Stale end.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_RANGE_MISMATCH" });
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: exact.replace("new ", "new"),
					explanation: "Whitespace was trimmed.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_HUNK_WHITESPACE" });
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: "@@ -1 +1 @@\n context\n context\n",
					explanation: "No edit.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_HUNK_CONTEXT_ONLY" });
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: "Binary files a/src/bin.dat and b/src/bin.dat differ\n",
					explanation: "Binary.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_HUNK_BINARY" });
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk: "@@@ -1,1 -1,1 +1,1 @@@\n-old\n+new\n",
					explanation: "Merge.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_HUNK_COMBINED" });
		expect(
			validateCodeHunkEvidence(
				{
					commitRange: `${BASE}..${END}`,
					diffHunk:
						"diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+assembled\n",
					explanation: "Assembled.",
				},
				context,
			),
		).toMatchObject({ code: "CODE_HUNK_NOT_FOUND" });
	});

	test("renders a bounded diff and an exact retrieval command", () => {
		const body = patch([{ path: "src/a.ts", from: "old", to: "new" }]);
		const parsed = parseCodePatch(body);
		const text = formatCodeReviewDiff(
			{
				contextId: "ctx-1",
				workdir: "/repo/root",
				diff: {
					baseCommit: BASE,
					reviewedCommit: END,
					patch: `${body}${"context\n".repeat(20)}`,
					patchHash: "sha256:00",
					excludedPaths: ["docs/development/runs"],
					hunks: parsed.hunks,
					binaryPaths: ["assets/logo.png"],
				},
			},
			3,
		);
		expect(text).toContain("ctx-1");
		expect(text).toContain("truncated");
		expect(text).toContain("src/a.ts -> src/a.ts");
		expect(text).toContain("assets/logo.png");
		expect(text).toContain("--no-ext-diff");
		expect(text).toContain("--no-textconv");
		expect(text).toContain("--diff-algorithm=myers");
		expect(text).toContain("--indent-heuristic");
		expect(text).toContain("--inter-hunk-context=0");
		expect(text).toContain("--no-relative");
		expect(text).toContain("-C /repo/root");
		expect(text).toContain(":(exclude,literal,top)docs/development/runs");
		expect(text).toContain(`${BASE}..${END}`);
		expect(text).toContain("Extended headers");
		expect(text).toContain("missing final newline");
	});

	test("accepts a verbatim rendered block and a missing trailing newline", () => {
		const raw = patch([{ path: "src/a.ts", from: "old", to: "new" }]);
		const parsed = parseCodePatch(raw);
		const context = {
			baseCommit: BASE,
			reviewedCommit: END,
			patch: raw,
			patchHash: "sha256:00",
			excludedPaths: [],
			hunks: parsed.hunks,
			binaryPaths: [],
		};
		const evidence = {
			commitRange: `${BASE}..${END}`,
			explanation: "The assignment changed.",
		};
		expect(
			validateCodeHunkEvidence({ ...evidence, diffHunk: raw }, context).valid,
		).toBe(true);
		const stored = parsed.hunks[0]?.text ?? "";
		expect(stored.endsWith("\n")).toBe(true);
		expect(
			validateCodeHunkEvidence(
				{ ...evidence, diffHunk: stored.slice(0, -1) },
				context,
			).valid,
		).toBe(true);
		expect(
			validateCodeHunkEvidence(
				{
					...evidence,
					diffHunk: raw.replace(
						"diff --git a/src/a.ts b/src/a.ts",
						"diff --git a/src/other.ts b/src/other.ts",
					),
				},
				context,
			),
		).toMatchObject({ valid: false, code: "CODE_HUNK_WRONG_FILE" });
	});

	test("lists a truncated later hunk when two files share an @@ header", () => {
		const body = patch([
			{ path: "src/a.ts", from: "old", to: "new" },
			{ path: "src/b.ts", from: "old", to: "new" },
		]);
		const parsed = parseCodePatch(body);
		const text = formatCodeReviewDiff(
			{
				contextId: "ctx-1",
				diff: {
					baseCommit: BASE,
					reviewedCommit: END,
					patch: body,
					patchHash: "sha256:00",
					excludedPaths: [],
					hunks: parsed.hunks,
					binaryPaths: [],
				},
			},
			8,
		);
		expect(text).toContain("src/b.ts -> src/b.ts: @@ -1 +1 @@");
		expect(text).not.toContain("src/a.ts -> src/a.ts: @@ -1 +1 @@");
	});
});

describe("code review closure inputs", () => {
	test("reads open findings from the latest reviewer step and carries decisions", () => {
		const { recordStore } = setup();
		step(recordStore, "reviewer:review", 1, END, {
			readiness: "not_ready",
			items: [
				{ id: "F1", title: "First", action: "auto_fix", reason: "Open." },
				{ id: "F2", title: "Second", action: "auto_fix", reason: "Open." },
			],
		});
		step(recordStore, "reviewer:review", 2, END, {
			readiness: "not_ready",
			priorFindings: [
				{ id: "F1", status: "addressed" },
				{ id: "F2", status: "still_open" },
			],
			items: [
				{
					id: "F2",
					title: "Second",
					action: "auto_fix",
					reason: "Still open.",
				},
			],
		});
		const decision = createReviewDecision({
			gateId: "gate-1",
			snapshotId: "snap-1",
			choice: "defer_accept_risk",
			findingRefs: [{ findingId: "F2", fingerprint: "fp-2" }],
			rationale: "Defer the remaining defect.",
			evidence: ["The old stack trace."],
			approvedScope: { retained: [], removed: [] },
			decisionId: "11111111-1111-4111-8111-111111111111",
			createdAt: "2026-09-23 00:00:01",
		});
		recordStore.append({
			runId: "run1",
			stream: "decisions",
			idempotencyKey: "decision:gate-1",
			payload: decision,
			createdAt: "2026-09-23 00:00:01",
			schemaVersion: 1,
			provenance: "recorded",
			origin: ORIGIN,
		});
		expect(readImplementationCodeClosure(recordStore, "run1", "1")).toEqual({
			priorReviewCount: 2,
			priorCodeFindings: [{ id: "F2" }],
			priorCodeDecisions: [
				{
					decisionId: decision.decisionId,
					findingIds: ["F2"],
					evidence: ["The old stack trace."],
				},
			],
		});
	});
});

describe("code review closure", () => {
	const parsed = parseCodePatch(
		patch([{ path: "src/a.ts", from: "old", to: "new" }]),
	);
	const diff = {
		baseCommit: BASE,
		reviewedCommit: END,
		patch: "",
		patchHash: "sha256:00",
		excludedPaths: [],
		hunks: parsed.hunks,
		binaryPaths: [],
	};
	const introduced = {
		commitRange: `${BASE}..${END}`,
		diffHunk: parsed.hunks[0]?.text ?? "",
		explanation: "The write path dropped the status.",
	};

	test("requires one outcome and exact evidence for a new ordinary blocker", () => {
		const open = validateCodeReviewClosure({
			reviewRound: 2,
			priorFindings: [{ id: "F1" }],
			codeContext: diff,
			verdict: {
				readiness: "not_ready",
				items: [],
				priorFindings: [{ id: "F1", status: "still_open" }],
			},
		});
		expect(open.diagnostics.map((item) => item.code)).toContain(
			"PRIOR_FINDING_ITEM_MISSING",
		);

		const fresh = validateCodeReviewClosure({
			reviewRound: 2,
			priorFindings: [{ id: "F1" }],
			codeContext: diff,
			verdict: {
				readiness: "not_ready",
				priorFindings: [{ id: "F1", status: "addressed" }],
				items: [
					{
						id: "F2",
						title: "New bug",
						action: "auto_fix",
						reason: "Still broken.",
						scopeClass: "implementation_defect",
						priority: "P1",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
						introducedBy: {
							...introduced,
							diffHunk:
								"diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+nope\n",
						},
					},
				],
			},
		});
		expect(fresh.diagnostics.map((item) => item.code)).toContain(
			"CODE_HUNK_NOT_FOUND",
		);

		const enforced = validateImplementationReview({
			verdict: {
				readiness: "not_ready",
				priorFindings: [{ id: "F1", status: "addressed" }],
				items: [
					{
						id: "F2",
						title: "New bug",
						action: "auto_fix",
						reason: "Still broken.",
						scopeClass: "implementation_defect",
						priority: "P1",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
						introducedBy: introduced,
					},
				],
			},
			phase: "1",
			mode: "enforced",
			phaseIds: ["1"],
			workItemIds: ["W1"],
			hasRun: true,
			priorReviewCount: 1,
			priorCodeFindings: [{ id: "F1" }],
			codeContext: diff,
		});
		expect(enforced.valid).toBe(true);
		expect(enforced.governance?.route).toBe("author_revision");
	});

	test("critical late issues skip the hunk and a deferred re-raise does not", () => {
		const critical = validateCodeReviewClosure({
			reviewRound: 2,
			codeContext: diff,
			verdict: {
				readiness: "not_ready",
				items: [
					{
						id: "S1",
						title: "Unsafe default",
						action: "human_required",
						reason: "Credentials are logged.",
						scopeClass: "implementation_defect",
						priority: "P1",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
						lateDiscovery: "critical_safety",
						lateDiscoveryEvidence: "The new log line prints the token.",
					},
				],
			},
		});
		expect(critical.forcesHuman).toBe(true);
		expect(
			critical.diagnostics.some(
				(item) => item.code === "NEW_FINDING_EVIDENCE_REQUIRED",
			),
		).toBe(false);

		const reraise = validateCodeReviewClosure({
			reviewRound: 2,
			codeContext: diff,
			decisions: [
				{
					decisionId: "dec-1",
					findingIds: ["F9"],
					evidence: ["The old stack trace."],
				},
			],
			verdict: {
				readiness: "not_ready",
				items: [
					{
						id: "F9",
						title: "Deferred bug",
						action: "auto_fix",
						reason: "It came back.",
						scopeClass: "implementation_defect",
						priority: "P1",
						effortDelta: 1,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
						priorDecisionId: "dec-1",
						newEvidence: "The failure now happens on the empty path.",
					},
				],
			},
		});
		expect(reraise.diagnostics.map((item) => item.code)).toContain(
			"NEW_FINDING_EVIDENCE_REQUIRED",
		);
	});
});

describe("pre-author capture and prepared context", () => {
	test("captures pre-author HEAD once and does not advance it", () => {
		const { recordStore } = setup();
		const first = capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "phase-1",
			preAuthorCommit: BASE,
		});
		const second = capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			preAuthorCommit: END,
		});
		expect(first.status).toBe("captured");
		expect(second).toMatchObject({
			status: "reused",
			admission: { preAuthorCommit: BASE, phase: "1" },
		});
		expect(readPhaseAuthorAdmission(recordStore, "run1", "1").status).toBe(
			"found",
		);
		const steps = recordStore
			.listLines("run1", "steps")
			.filter(
				(line) =>
					(line.payload as { step_name?: string }).step_name ===
					PRE_AUTHOR_STEP_NAME,
			);
		expect(steps).toHaveLength(1);
	});

	test("prepares one context from the captured base across retries and review-only commits", async () => {
		const { recordStore, store } = setup();
		capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			preAuthorCommit: BASE,
		});
		step(recordStore, "git:commit", 1, MID);
		step(recordStore, "git:commit", 2, END);
		step(recordStore, "author:implement", 1, END, {
			result: "complete",
			commit: END,
		});
		const git = fakeGit();
		const first = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: ["docs/development/reviews"],
			git,
		});
		expect(first.status).toBe("ready");
		if (first.status !== "ready") return;
		expect(first.diff.baseCommit).toBe(BASE);
		expect(first.diff.reviewedCommit).toBe(END);
		expect(first.created).toBe(true);
		const again = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: ["docs/development/reviews"],
			git: fakeGit(),
		});
		expect(again).toMatchObject({
			status: "ready",
			created: false,
			context: { id: first.context.id },
		});
		step(recordStore, "git:commit", 3, REVIEW);
		const reviewOnly = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: ["docs/development/reviews"],
			git: fakeGit({ head: REVIEW }),
		});
		expect(reviewOnly.status).toBe("ready");
		if (reviewOnly.status !== "ready") return;
		expect(reviewOnly.context.id).toBe(first.context.id);
		expect(reviewOnly.context.reviewedCommit).toBe(END);
	});

	test("keeps an empty range when no admitted commit moves the captured base", async () => {
		const { recordStore, store } = setup();
		capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			preAuthorCommit: BASE,
		});
		const prepared = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit({ head: BASE, patch: "" }),
		});
		expect(prepared.status).toBe("ready");
		if (prepared.status !== "ready") return;
		expect(prepared.diff.baseCommit).toBe(BASE);
		expect(prepared.diff.reviewedCommit).toBe(BASE);
		expect(prepared.diff.patch).toBe("");
		expect(
			formatCodeReviewDiff({
				contextId: prepared.context.id,
				diff: prepared.diff,
			}),
		).toContain("no code changes");
	});

	test("does not stamp post-work HEAD when the phase already has commits", async () => {
		const { recordStore, store } = setup();
		step(recordStore, "git:commit", 1, MID);
		step(recordStore, "git:commit", 2, END);
		step(recordStore, "author:implement", 1, END, {
			result: "complete",
			commit: END,
		});
		const captured = capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			preAuthorCommit: END,
		});
		expect(captured.status).toBe("skipped");
		expect(readPhaseAuthorAdmission(recordStore, "run1", "1").status).toBe(
			"missing",
		);
		const prepared = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit(),
		});
		expect(prepared.status).toBe("ready");
		if (prepared.status !== "ready") return;
		expect(prepared.diff.baseCommit).toBe(BASE);
		expect(prepared.diff.reviewedCommit).toBe(END);
	});

	test("uses the earliest git:commit parent and fails when that base is missing", async () => {
		const { recordStore, store } = setup();
		step(recordStore, "git:commit", 1, MID);
		step(recordStore, "git:commit", 2, END);
		step(recordStore, "author:implement", 1, null, {
			result: "complete",
			commit: END,
		});
		const prepared = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit(),
		});
		expect(prepared.status).toBe("ready");
		if (prepared.status !== "ready") return;
		expect(prepared.diff.baseCommit).toBe(BASE);
		expect(prepared.diff.reviewedCommit).toBe(END);

		const empty = setup();
		step(empty.recordStore, "author:implement", 1, END, {
			result: "complete",
			commit: END,
		});
		const missing = await prepareImplementationReviewContext({
			store: empty.store,
			recordStore: empty.recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit(),
		});
		expect(missing).toMatchObject({
			status: "error",
			code: "CODE_DIFF_MISSING_BASE",
		});
		expect(
			empty.recordStore
				.listLines("run1", "steps")
				.some(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						PRE_AUTHOR_STEP_NAME,
				),
		).toBe(false);
	});

	test("rejects a dirty tree, a bad ref, reuse across phases, and a rewritten patch", async () => {
		const { recordStore, store } = setup();
		capturePhaseAuthorAdmission({
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			preAuthorCommit: BASE,
		});
		step(recordStore, "git:commit", 1, END);
		const dirty = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit({ dirty: " M src/a.ts" }),
		});
		expect(dirty).toMatchObject({ status: "error", code: "CODE_DIFF_DIRTY" });

		const bad = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit({ missing: [END] }),
		});
		expect(bad).toMatchObject({ status: "error", code: "CODE_DIFF_BAD_REF" });

		const ready = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit(),
		});
		expect(ready.status).toBe("ready");
		if (ready.status !== "ready") return;
		const reused = await verifyImplementationReviewContext({
			store,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "2",
			reviewContextId: ready.context.id,
			git: fakeGit(),
		});
		expect(reused).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_REUSE",
		});
		const stale = await verifyImplementationReviewContext({
			store,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			reviewContextId: ready.context.id,
			git: fakeGit({
				patch: patch([{ path: "src/a.ts", from: "old", to: "rewritten" }]),
			}),
		});
		expect(stale).toMatchObject({ status: "error", code: "CODE_DIFF_STALE" });

		const intervening = await prepareImplementationReviewContext({
			store,
			recordStore,
			origin: ORIGIN,
			executionRunId: "run1",
			bindingId: "bind-1",
			phase: "1",
			excludedPaths: [],
			git: fakeGit({ head: REVIEW, nameStatus: "M\tsrc/a.ts\n" }),
		});
		expect(intervening).toMatchObject({
			status: "error",
			code: "CODE_DIFF_INTERVENING",
		});
	});
});
