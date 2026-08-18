/**
 * Built-in doctor check registry and aggregation helpers.
 *
 * Phase 5/6 populate `builtinDoctorChecks`. Plugin contribution is deferred.
 */

import type { DoctorCheck, DoctorFinding, DoctorReport } from "./types.js";

/** Built-in checks — plugin contribution deferred. Phase 5/6 populate this. */
export const builtinDoctorChecks: DoctorCheck[] = [];

export function summarizeDoctor(
	findings: DoctorFinding[],
	fixed: DoctorReport["fixed"],
): DoctorReport {
	return {
		ok: findings.every((f) => f.status !== "fail"),
		checks: findings,
		fixed,
	};
}

export function doctorExitCode(report: DoctorReport): number {
	return report.ok ? 0 : 1;
}

/** Stable code when a check throws — must not abort the sweep. */
export const DOCTOR_CHECK_FAILED = "CHECK_FAILED";

export function checkFailedFinding(
	checkId: string,
	err: unknown,
): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: checkId,
		status: "fail",
		code: DOCTOR_CHECK_FAILED,
		message: `Doctor check "${checkId}" failed: ${message}`,
		fixable: false,
		detail: { error: message },
	};
}

/**
 * Identity of one finding for `--fix` re-detect matching.
 * NEVER match on `code` alone: two stale locks share `LOCK_STALE`.
 * Identifying detail (required on the finding when that code is emitted):
 *   LOCK_CORRUPT              → detail.lockPath
 *   LOCK_STALE / LOCK_LIVE    → detail.planPath
 *   HARNESS_STALE / UNKNOWN   → detail.harness AND detail.scope
 *                               (both required; either missing → "")
 *   WORKTREE_MAPPING_MISSING  → detail.planPath
 *
 * Invariant: a `fixable: true` finding MUST produce a non-empty identity
 * component. The switch `default` returns `""` (also the fallback when a
 * known code's identifying field is missing). Two-field identities return
 * `""` unless *every* sub-field is non-empty — do not colon-join partials
 * (`":"` / `"opencode:"` would otherwise pass `ident === ""` and silently
 * collapse). If the finding is `fixable`, throw rather than returning
 * `${check}:${code}:` — that collapse would silently reintroduce code-only
 * matching for any future check that forgets to add itself here.
 * Non-fixable findings (ok summaries, CHECK_FAILED, LOCK_LIVE with no
 * plan path, etc.) may use the empty identity form.
 */
export function findingKey(f: DoctorFinding): string {
	const d =
		f.detail && typeof f.detail === "object" && !Array.isArray(f.detail)
			? (f.detail as Record<string, unknown>)
			: {};
	const ident = (() => {
		switch (f.code) {
			case "LOCK_CORRUPT":
				return String(d.lockPath ?? "");
			case "LOCK_STALE":
			case "LOCK_LIVE":
				return String(d.planPath ?? "");
			case "HARNESS_STALE":
			case "HARNESS_UNKNOWN": {
				const harness = String(d.harness ?? "");
				const scope = String(d.scope ?? "");
				return harness && scope ? `${harness}:${scope}` : "";
			}
			case "WORKTREE_MAPPING_MISSING":
				return String(d.planPath ?? "");
			default:
				return "";
		}
	})();
	if (f.fixable && ident === "") {
		throw new Error(
			`findingKey: fixable finding ${f.check}/${f.code} has empty identity; add a switch case and identifying detail before marking it fixable`,
		);
	}
	return `${f.check}:${f.code}:${ident}`;
}
