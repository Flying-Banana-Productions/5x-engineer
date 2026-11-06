/**
 * Runtime plan evidence for implementation reviews.
 *
 * Plan evidence sits beside, not inside, code-hunk evidence. It carries the
 * effective approved plan identity, the governing text of the reviewed
 * phase with line locations, the shared executability diagnostics, and the
 * optional plan-only diff of the reviewed range. The code range, its patch
 * hash and code-diff freshness never include the plan.
 *
 * Native render and invoke both build this through
 * `buildImplementationReviewPromptContext`, so fresh and continued sessions
 * receive the same plan authority even with older local prompt overrides.
 */

import { phaseSectionRanges } from "../parsers/plan.js";
import { authoritativePlan } from "../plan-schema/authority.js";
import {
	diagnosePlanExecutability,
	type PlanExecutabilityDiagnostic,
} from "../plan-schema/checklist-repair.js";
import type { PlanSchema } from "../plan-schema/document.js";
import { executabilityRepairCommands } from "../review-budget/plan-repair.js";
import { CODE_DIFF_OPTIONS, type CodeDiffGit } from "./code-diff.js";

/** Lines of governing phase text or plan-only diff shown inline. */
const MAX_INLINE_LINES = 200;

export interface PlanOnlyDiff {
	path: string;
	baseCommit: string;
	reviewedCommit: string;
	diff: string;
	truncatedLines: number;
}

export interface ImplementationPlanEvidence {
	approvedPlanHash: string;
	revisionId: string;
	schema: PlanSchema;
	governingHash: string | null;
	planPath: string | null;
	phase: {
		id: string;
		heading: string;
		startLine: number;
		endLine: number;
		text: string;
		truncatedLines: number;
	} | null;
	diagnostics: PlanExecutabilityDiagnostic[];
	repairCommands: string[];
	planOnlyDiff: PlanOnlyDiff | null;
	planOnlyDiffRetrieval: string | null;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function planDiffArgs(input: {
	baseCommit: string;
	reviewedCommit: string;
	path: string;
}): string[] {
	return [
		...CODE_DIFF_OPTIONS,
		`${input.baseCommit}..${input.reviewedCommit}`,
		"--",
		`:(literal,top)${input.path}`,
	];
}

export function planOnlyDiffRetrievalCommand(input: {
	baseCommit: string;
	reviewedCommit: string;
	path: string;
	workdir?: string;
}): string {
	return [
		"git",
		...(input.workdir ? ["-C", input.workdir] : []),
		...planDiffArgs(input),
	]
		.map(shellQuote)
		.join(" ");
}

function capLines(
	text: string,
	max: number,
): { text: string; truncatedLines: number } {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length <= max) return { text: lines.join("\n"), truncatedLines: 0 };
	return {
		text: lines.slice(0, max).join("\n"),
		truncatedLines: lines.length - max,
	};
}

/**
 * Plan-only changes in the reviewed range. Null when the plan path is not
 * in the repository, unchanged in the range, or git cannot produce it.
 */
export async function readPlanOnlyDiff(input: {
	git: CodeDiffGit;
	baseCommit: string;
	reviewedCommit: string;
	planRepoPath: string | null;
}): Promise<PlanOnlyDiff | null> {
	if (!input.planRepoPath) return null;
	if (input.baseCommit === input.reviewedCommit) return null;
	const result = await input.git.exec(
		planDiffArgs({
			baseCommit: input.baseCommit,
			reviewedCommit: input.reviewedCommit,
			path: input.planRepoPath,
		}),
		{ exact: true },
	);
	if (result.exitCode !== 0 || result.stdout.trim() === "") return null;
	const capped = capLines(result.stdout, MAX_INLINE_LINES);
	return {
		path: input.planRepoPath,
		baseCommit: input.baseCommit,
		reviewedCommit: input.reviewedCommit,
		diff: capped.text,
		truncatedLines: capped.truncatedLines,
	};
}

/**
 * Pure evidence over the effective approved bytes. Only governing content
 * is shown: schema 1 notes and text outside the contract are masked by the
 * same authority read that phase parsing uses, and line numbers are raw
 * plan lines.
 */
export function buildImplementationPlanEvidence(input: {
	runId: string;
	phaseId: string;
	approvedPlanBytes: string;
	approvedPlanHash: string;
	revisionId: string;
	schema: PlanSchema;
	governingHash?: string;
	planRepoPath?: string | null;
	planOnlyDiff?: PlanOnlyDiff | null;
	reviewRange?: { baseCommit: string; reviewedCommit: string } | null;
	workdir?: string;
}): ImplementationPlanEvidence {
	const loaded = authoritativePlan(input.approvedPlanBytes, input.schema);
	// An unreadable anchor shows no phase text rather than ungoverned bytes.
	const governing = loaded.ok ? loaded.document.authorityMarkdown : "";
	const range = phaseSectionRanges(governing).find(
		(entry) => entry.number === input.phaseId,
	);
	let phase: ImplementationPlanEvidence["phase"] = null;
	if (range) {
		const lines = governing.split(/\r\n|\n|\r/);
		const body = lines
			.slice(range.startLine - 1, range.endLine)
			.map((line) => line.trimEnd())
			.join("\n")
			.replace(/\n{3,}/gu, "\n\n")
			.trim();
		const capped = capLines(body, MAX_INLINE_LINES);
		phase = {
			id: range.number,
			heading: range.heading.trim(),
			startLine: range.startLine,
			endLine: range.endLine,
			text: capped.text,
			truncatedLines: capped.truncatedLines,
		};
	}
	const diagnosed = diagnosePlanExecutability(
		input.approvedPlanBytes,
		input.schema,
	);
	const diagnostics = diagnosed.ok
		? diagnosed.result.diagnostics.filter(
				(entry) => entry.phase === null || entry.phase === input.phaseId,
			)
		: [];
	const repairCommands = executabilityRepairCommands(
		diagnostics.filter((entry) => entry.severity === "error"),
		{ kind: "run", runId: input.runId },
	);
	const planPath = input.planRepoPath ?? null;
	return {
		approvedPlanHash: input.approvedPlanHash,
		revisionId: input.revisionId,
		schema: input.schema,
		governingHash: input.governingHash ?? null,
		planPath,
		phase,
		diagnostics,
		repairCommands,
		planOnlyDiff: input.planOnlyDiff ?? null,
		planOnlyDiffRetrieval:
			planPath && input.reviewRange
				? planOnlyDiffRetrievalCommand({
						baseCommit: input.reviewRange.baseCommit,
						reviewedCommit: input.reviewRange.reviewedCommit,
						path: planPath,
						...(input.workdir ? { workdir: input.workdir } : {}),
					})
				: null,
	};
}

const PLAN_EVIDENCE_RULES =
	'The code-hunk requirement applies to implementation defects. A structural plan defect (`scopeClass: "plan_defect"`, for example a phase with no executable checklist) needs no code hunk and need not have been introduced by the reviewed commits: cite `planImpact` with a `heading` and verbatim `staleText` from the governing text above, or from the plan-only diff when the plan changed in this range. A mechanical checklist repair needs no reviewer finding; report its command instead of inventing a defect. Do not return `not_ready` without at least one item.';

export function formatImplementationPlanEvidence(
	evidence: ImplementationPlanEvidence,
): string {
	const identity = [
		`- Effective approved plan hash: ${evidence.approvedPlanHash}`,
		`- Effective revision: ${evidence.revisionId}`,
		`- Plan schema: ${evidence.schema}${evidence.governingHash ? `; governing hash ${evidence.governingHash}` : ""}`,
		`- Plan path: ${evidence.planPath ?? "(unknown)"}`,
	].join("\n");
	const phase = evidence.phase
		? `Governing text of ${evidence.phase.heading.replace(/^#+\s*/u, "")} (approved plan lines ${evidence.phase.startLine}–${evidence.phase.endLine}):\n\n\`\`\`markdown\n${evidence.phase.text}\n\`\`\`${evidence.phase.truncatedLines > 0 ? `\n\n... (truncated, ${evidence.phase.truncatedLines} more lines)` : ""}`
		: "The reviewed phase has no governing section in the effective approved plan.";
	const diagnostics = evidence.diagnostics.length
		? evidence.diagnostics
				.map(
					(entry) =>
						`- ${entry.code} (${entry.severity}${entry.line !== null ? `, line ${entry.line}` : ""}; repair: ${entry.repair}): ${entry.message}`,
				)
				.join("\n")
		: "- (none)";
	const repair = evidence.repairCommands.length
		? `\n\nDirect repair on this run (operator-authorized; no reviewer finding needed):\n${evidence.repairCommands.map((command) => `- \`${command}\``).join("\n")}`
		: "";
	const diff = evidence.planOnlyDiff
		? `Plan-only changes in \`${evidence.planOnlyDiff.baseCommit}..${evidence.planOnlyDiff.reviewedCommit}\` (excluded from the code diff and its freshness):\n\n\`\`\`diff\n${evidence.planOnlyDiff.diff}\n\`\`\`${evidence.planOnlyDiff.truncatedLines > 0 ? `\n\n... (truncated, ${evidence.planOnlyDiff.truncatedLines} more lines)` : ""}`
		: "- (no plan-only changes in the reviewed range)";
	const retrieval = evidence.planOnlyDiffRetrieval
		? `\n\nRetrieve the plan-only diff with:\n\n\`${evidence.planOnlyDiffRetrieval}\``
		: "";
	return `### Plan evidence\n\n${identity}\n\n${phase}\n\n#### Executability diagnostics\n\n${diagnostics}${repair}\n\n#### Plan-only diff\n\n${diff}${retrieval}\n\n${PLAN_EVIDENCE_RULES}`;
}
