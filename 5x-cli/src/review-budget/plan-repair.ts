import { readAuthoritativeBudget } from "../plan-schema/authority.js";
import {
	diagnosePlanExecutability,
	type PlanExecutability,
	type PlanExecutabilityDiagnostic,
} from "../plan-schema/checklist-repair.js";
import type { ExpectedPlanSchema } from "../plan-schema/document.js";
import { isCompleteDebtClaimEvidence } from "./types.js";

/** A plan defect is an author repair gate, not an invalid reviewer response. */
export function planReviewRepairGate(planMarkdown: string) {
	const loaded = readAuthoritativeBudget(planMarkdown, "file");
	if (!loaded.ok) {
		return {
			status: "error" as const,
			code: "PLAN_REPAIR_REQUIRED",
			message: `Author repair required before plan review [${loaded.code}]: ${loaded.message} This is not a legacy fallback.`,
			detail: {
				reviewRoute: "author_revision",
				diagnostic: {
					code: loaded.code,
					message: loaded.message,
				},
				remediation:
					"Have the author repair and commit the Delivery Budget, then render/invoke the same review again. No reviewer verdict is required for this pre-review repair gate; it records no review and preserves the existing baseline. If this gate occurred while recording, re-review the repaired plan before recording a verdict.",
			},
		};
	}
	const parsed = loaded.parsed;
	const incomplete = parsed.ok
		? parsed.value.workItems.find(
				(item) =>
					item.architectureDelta < 0 &&
					!isCompleteDebtClaimEvidence(item.debtClaim),
			)
		: undefined;
	if (parsed.ok && !incomplete) return null;
	const diagnostic = !parsed.ok
		? {
				code: parsed.code,
				message: parsed.message,
				...(parsed.line ? { line: parsed.line } : {}),
			}
		: {
				code: "BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED",
				message: `Work item '${incomplete?.id}' requires complete debt-claim evidence`,
			};
	return {
		status: "error" as const,
		code: "PLAN_REPAIR_REQUIRED",
		message: `Author repair required before plan review [${diagnostic.code}]: ${diagnostic.message}`,
		detail: {
			reviewRoute: "author_revision",
			diagnostic,
			remediation:
				"Have the author repair and commit the Delivery Budget, then render/invoke the same review again. No reviewer verdict is required for this pre-review repair gate; it records no review and preserves the existing baseline. If this gate occurred while recording, re-review the repaired plan before recording a verdict.",
		},
	};
}

// ---------------------------------------------------------------------------
// Executability boundaries
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Who may perform a checklist repair. `file`: an unapproved or ungoverned
 * plan repaired with the file form, which redirects to the run form when a
 * run governs the plan. `run`: an approved plan repaired on this run under
 * the operator's instruction.
 */
export type ExecutabilityRepairSubject =
	| { kind: "file"; planPath: string }
	| { kind: "run"; runId: string };

function selectorFor(subject: ExecutabilityRepairSubject): string {
	return subject.kind === "file"
		? `--plan ${shellQuote(subject.planPath)}`
		: `--run ${subject.runId}`;
}

/**
 * Ready-to-run repair previews for the given diagnostics. Mechanical repairs
 * share one default preview. A `select_lines` repair names its phase and,
 * per candidate list, the exact line range.
 */
export function executabilityRepairCommands(
	diagnostics: readonly PlanExecutabilityDiagnostic[],
	subject: ExecutabilityRepairSubject,
): string[] {
	const base = `5x plan repair-checklists ${selectorFor(subject)}`;
	const commands: string[] = [];
	if (diagnostics.some((entry) => entry.repair === "mechanical")) {
		commands.push(`${base} --dry-run`);
	}
	for (const entry of diagnostics) {
		if (entry.repair !== "select_lines" || entry.phase === null) continue;
		for (const block of entry.candidates ?? []) {
			commands.push(
				`${base} --phase ${entry.phase} --lines ${block.startLine}-${block.endLine} --dry-run`,
			);
		}
	}
	return [...new Set(commands)];
}

export interface ExecutabilityRepairGate {
	status: "error";
	code: "PLAN_REPAIR_REQUIRED" | "PLAN_CHECKLIST_REPAIR_REQUIRED";
	message: string;
	detail: {
		reviewRoute?: "author_revision";
		executability: PlanExecutability;
		diagnostics: PlanExecutabilityDiagnostic[];
		next: string[];
		remediation: string;
		runPreserved: true;
	};
}

function summarize(diagnostics: readonly PlanExecutabilityDiagnostic[]) {
	return diagnostics.map((entry) => entry.message).join(" ");
}

/**
 * Pre-review gate for a draft plan, in every review-budget mode. A
 * non-executable draft routes to the author before any reviewer is invoked;
 * no review is recorded and no reviewer iteration or human gate is consumed.
 * Schema errors are left to the existing schema/budget gates.
 */
export function planReviewExecutabilityGate(input: {
	planMarkdown: string;
	planPath: string;
	expected?: ExpectedPlanSchema;
}): ExecutabilityRepairGate | null {
	const diagnosed = diagnosePlanExecutability(
		input.planMarkdown,
		input.expected ?? "file",
	);
	if (!diagnosed.ok || diagnosed.result.executable) return null;
	const errors = diagnosed.result.diagnostics.filter(
		(entry) => entry.severity === "error",
	);
	const next = executabilityRepairCommands(errors, {
		kind: "file",
		planPath: input.planPath,
	});
	const mechanical = errors.every((entry) => entry.repair !== "author");
	return {
		status: "error",
		code: "PLAN_REPAIR_REQUIRED",
		message: `Author repair required before plan review [PLAN_NOT_EXECUTABLE]: ${summarize(errors)}`,
		detail: {
			reviewRoute: "author_revision",
			executability: diagnosed.result,
			diagnostics: errors,
			next,
			remediation: mechanical
				? "Have the author run the repair preview, apply it, and commit the plan, then render/invoke the same review again. No reviewer verdict, human gate or new run is required; no review is recorded and the baseline is preserved."
				: "Have the author add executable checklist items (`- [ ]`) or fix the phase headings, commit the plan, then render/invoke the same review again. No reviewer verdict, human gate or new run is required; no review is recorded and the baseline is preserved.",
			runPreserved: true,
		},
	};
}

/**
 * Pre-author/resume gate for one implementation phase. Blocks only when the
 * target phase has no executable items and a mechanical (or line-selected)
 * repair exists, returning the exact repair preview on the same run. A phase
 * that needs author work is returned as a nonblocking warning: completion
 * already refuses it, and a new blocker without a repair would be a dead end.
 */
export function implementationPhaseExecutabilityGate(input: {
	planMarkdown: string;
	phase: string;
	subject: ExecutabilityRepairSubject;
	expected?: ExpectedPlanSchema;
}): { status: "ok"; warning?: string } | ExecutabilityRepairGate {
	const diagnosed = diagnosePlanExecutability(
		input.planMarkdown,
		input.expected ?? "file",
	);
	if (!diagnosed.ok) return { status: "ok" };
	const target = diagnosed.result.diagnostics.filter(
		(entry) =>
			entry.code === "PLAN_PHASE_NO_CHECKLIST" && entry.phase === input.phase,
	);
	if (target.length === 0) return { status: "ok" };
	const repairable = target.filter((entry) => entry.repair !== "author");
	if (repairable.length === 0) {
		return {
			status: "ok",
			warning: `${summarize(target)} The phase cannot be checked off until requirements are added through ${input.subject.kind === "run" ? "the scoped plan amendment process (5x review implementation amend --help)" : "an author revision"}.`,
		};
	}
	const next = executabilityRepairCommands(repairable, input.subject);
	const authority =
		input.subject.kind === "run"
			? "Under the operator's repair instruction, preview and apply the mechanical repair on this same run (no reviewer finding, gate, re-review or new run is needed), then delegate the phase again."
			: "Preview and apply the mechanical repair to the plan file, then delegate the phase again.";
	return {
		status: "error",
		code: "PLAN_CHECKLIST_REPAIR_REQUIRED",
		message: `Phase ${input.phase} cannot be delegated: ${summarize(repairable)} ${authority} Next: ${next.join(" ; ")}`,
		detail: {
			executability: diagnosed.result,
			diagnostics: repairable,
			next,
			remediation: authority,
			runPreserved: true,
		},
	};
}
