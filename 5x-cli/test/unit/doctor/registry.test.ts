/**
 * Unit tests for doctor registry helpers: summarize, exit code, findingKey.
 */

import { describe, expect, test } from "bun:test";
import {
	builtinDoctorChecks,
	checkFailedFinding,
	DOCTOR_CHECK_FAILED,
	doctorExitCode,
	findingKey,
	summarizeDoctor,
} from "../../../src/doctor/registry.js";
import type { DoctorFinding } from "../../../src/doctor/types.js";

function finding(
	partial: Partial<DoctorFinding> &
		Pick<DoctorFinding, "check" | "code" | "status">,
): DoctorFinding {
	return {
		message: partial.message ?? partial.code,
		fixable: partial.fixable ?? false,
		...partial,
	};
}

describe("builtinDoctorChecks", () => {
	test("is empty until later phases register checks", () => {
		expect(builtinDoctorChecks).toEqual([]);
	});
});

describe("summarizeDoctor / doctorExitCode", () => {
	test("empty findings → ok, exit 0", () => {
		const report = summarizeDoctor([], []);
		expect(report.ok).toBe(true);
		expect(report.checks).toEqual([]);
		expect(report.fixed).toEqual([]);
		expect(doctorExitCode(report)).toBe(0);
	});

	test("warn-only findings → ok, exit 0", () => {
		const report = summarizeDoctor(
			[
				finding({
					check: "locks",
					code: "LOCK_LIVE",
					status: "warn",
					message: "live lock",
					detail: { planPath: "docs/foo.md" },
				}),
				finding({
					check: "runs",
					code: "RUN_LINGERING",
					status: "warn",
					message: "lingering run",
				}),
			],
			[],
		);
		expect(report.ok).toBe(true);
		expect(doctorExitCode(report)).toBe(0);
	});

	test("any fail → not ok, exit 1", () => {
		const report = summarizeDoctor(
			[
				finding({
					check: "locks",
					code: "LOCK_LIVE",
					status: "warn",
				}),
				finding({
					check: "db",
					code: "DB_MISSING",
					status: "fail",
					message: "no database",
				}),
			],
			[],
		);
		expect(report.ok).toBe(false);
		expect(doctorExitCode(report)).toBe(1);
	});

	test("ok findings stay ok", () => {
		const report = summarizeDoctor(
			[
				finding({
					check: "db",
					code: "DB_OK",
					status: "ok",
					message: "schema v5, integrity ok",
				}),
			],
			[],
		);
		expect(report.ok).toBe(true);
		expect(doctorExitCode(report)).toBe(0);
	});
});

describe("checkFailedFinding", () => {
	test("wraps an Error as CHECK_FAILED", () => {
		const f = checkFailedFinding("locks", new Error("boom"));
		expect(f).toEqual({
			check: "locks",
			status: "fail",
			code: DOCTOR_CHECK_FAILED,
			message: 'Doctor check "locks" failed: boom',
			fixable: false,
			detail: { error: "boom" },
		});
	});

	test("stringifies non-Error throws", () => {
		const f = checkFailedFinding("db", "nope");
		expect(f.code).toBe("CHECK_FAILED");
		expect(f.message).toContain("nope");
		expect(f.fixable).toBe(false);
	});
});

describe("findingKey", () => {
	test("distinguishes two LOCK_STALE findings by detail.planPath", () => {
		const a = finding({
			check: "locks",
			code: "LOCK_STALE",
			status: "fail",
			fixable: true,
			detail: { planPath: "docs/a.md" },
		});
		const b = finding({
			check: "locks",
			code: "LOCK_STALE",
			status: "fail",
			fixable: true,
			detail: { planPath: "docs/b.md" },
		});
		expect(findingKey(a)).toBe("locks:LOCK_STALE:docs/a.md");
		expect(findingKey(b)).toBe("locks:LOCK_STALE:docs/b.md");
		expect(findingKey(a)).not.toBe(findingKey(b));
	});

	test("LOCK_CORRUPT keys on detail.lockPath", () => {
		const f = finding({
			check: "locks",
			code: "LOCK_CORRUPT",
			status: "fail",
			fixable: true,
			detail: { lockPath: "/tmp/.5x/locks/orphan.lock" },
		});
		expect(findingKey(f)).toBe("locks:LOCK_CORRUPT:/tmp/.5x/locks/orphan.lock");
	});

	test("HARNESS_STALE / HARNESS_UNKNOWN key on harness:scope when both present", () => {
		expect(
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_STALE",
					status: "fail",
					fixable: true,
					detail: { harness: "opencode", scope: "project" },
				}),
			),
		).toBe("harness-freshness:HARNESS_STALE:opencode:project");
		expect(
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_UNKNOWN",
					status: "fail",
					fixable: true,
					detail: { harness: "claude-code", scope: "project" },
				}),
			),
		).toBe("harness-freshness:HARNESS_UNKNOWN:claude-code:project");
	});

	test("WORKTREE_MAPPING_MISSING keys on detail.planPath", () => {
		expect(
			findingKey(
				finding({
					check: "worktrees",
					code: "WORKTREE_MAPPING_MISSING",
					status: "fail",
					fixable: true,
					detail: { planPath: "docs/foo.md" },
				}),
			),
		).toBe("worktrees:WORKTREE_MAPPING_MISSING:docs/foo.md");
	});

	test("throws when fixable: true and identity is empty (unknown code)", () => {
		expect(() =>
			findingKey(
				finding({
					check: "locks",
					code: "FUTURE_FIXABLE",
					status: "fail",
					fixable: true,
				}),
			),
		).toThrow(/empty identity/);
	});

	test("throws when fixable LOCK_STALE is missing planPath", () => {
		expect(() =>
			findingKey(
				finding({
					check: "locks",
					code: "LOCK_STALE",
					status: "fail",
					fixable: true,
					detail: {},
				}),
			),
		).toThrow(/empty identity/);
	});

	test("throws when fixable HARNESS_STALE is missing harness", () => {
		expect(() =>
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_STALE",
					status: "fail",
					fixable: true,
					detail: { scope: "project" },
				}),
			),
		).toThrow(/empty identity/);
	});

	test("throws when fixable HARNESS_UNKNOWN is missing scope", () => {
		expect(() =>
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_UNKNOWN",
					status: "fail",
					fixable: true,
					detail: { harness: "opencode" },
				}),
			),
		).toThrow(/empty identity/);
	});

	test("throws when fixable HARNESS_STALE has both fields missing", () => {
		expect(() =>
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_STALE",
					status: "fail",
					fixable: true,
					detail: {},
				}),
			),
		).toThrow(/empty identity/);
	});

	test("throws when fixable finding has non-object detail", () => {
		expect(() =>
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_STALE",
					status: "fail",
					fixable: true,
					detail: "not-an-object",
				}),
			),
		).toThrow(/empty identity/);
		expect(() =>
			findingKey(
				finding({
					check: "harness-freshness",
					code: "HARNESS_STALE",
					status: "fail",
					fixable: true,
					detail: [{ harness: "opencode", scope: "project" }],
				}),
			),
		).toThrow(/empty identity/);
	});

	test("non-fixable unknown codes still return check:code: empty identity", () => {
		expect(
			findingKey(
				finding({
					check: "db",
					code: "CHECK_FAILED",
					status: "fail",
					fixable: false,
				}),
			),
		).toBe("db:CHECK_FAILED:");
		expect(
			findingKey(
				finding({
					check: "locks",
					code: "LOCK_LIVE",
					status: "warn",
					fixable: false,
				}),
			),
		).toBe("locks:LOCK_LIVE:");
	});
});
