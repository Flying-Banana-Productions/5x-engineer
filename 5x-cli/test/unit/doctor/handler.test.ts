/**
 * Unit tests for doctor handler: exception isolation, detect→fix→re-detect,
 * JSON/text envelopes, and adapter registration.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
	doctorRun,
	formatDoctorText,
} from "../../../src/commands/doctor.handler.js";
import { registerDoctor } from "../../../src/commands/doctor.js";
import type {
	DoctorCheck,
	DoctorFinding,
	DoctorReport,
} from "../../../src/doctor/types.js";
import { setOutputFormat } from "../../../src/output.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

async function captureJson(fn: () => Promise<void>): Promise<{
	ok: boolean;
	data?: DoctorReport;
}> {
	const calls: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		calls.push(String(args[0]));
	};
	try {
		await fn();
	} finally {
		console.log = orig;
	}
	const raw = calls[0];
	if (raw === undefined) throw new Error("expected JSON output");
	return JSON.parse(raw) as { ok: boolean; data?: DoctorReport };
}

function captureText(fn: () => void): string {
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(String(args[0]));
	};
	try {
		fn();
	} finally {
		console.log = orig;
	}
	return lines.join("\n");
}

function staleFinding(planPath: string): DoctorFinding {
	return {
		check: "locks",
		status: "fail",
		code: "LOCK_STALE",
		message: `stale lock on ${planPath}`,
		remediation: `5x unlock ${planPath}`,
		fixable: true,
		detail: { planPath },
	};
}

const prevExitCode = process.exitCode;

afterEach(() => {
	setOutputFormat("json");
	process.exitCode = prevExitCode ?? 0;
});

describe("registerDoctor", () => {
	test("registers doctor with --fix and help examples", () => {
		const program = new Command("5x");
		registerDoctor(program);
		const doctor = program.commands.find((c) => c.name() === "doctor");
		expect(doctor).toBeDefined();
		expect(doctor?.options.some((o) => o.long === "--fix")).toBe(true);

		const chunks: string[] = [];
		doctor?.configureOutput({
			writeOut: (str) => {
				chunks.push(str);
			},
			writeErr: (str) => {
				chunks.push(str);
			},
		});
		doctor?.outputHelp();
		const help = chunks.join("");
		expect(help).toContain("$ 5x doctor");
		expect(help).toContain("$ 5x doctor --fix");
		expect(help).toContain("$ 5x doctor --text");
	});
});

describe("formatDoctorText", () => {
	test("empty report prints (none)", () => {
		expect(
			captureText(() => formatDoctorText({ ok: true, checks: [], fixed: [] })),
		).toBe("(none)");
	});

	test("aligns check id / status and prints remediation", () => {
		const text = captureText(() =>
			formatDoctorText({
				ok: false,
				checks: [
					{
						check: "harness-freshness",
						status: "fail",
						code: "HARNESS_STALE",
						message: "opencode (project) assets are stale",
						remediation: "5x harness sync",
						fixable: true,
						detail: { harness: "opencode", scope: "project" },
					},
					{
						check: "locks",
						status: "warn",
						code: "LOCK_LIVE",
						message: "live lock on docs/foo.md (pid 1234)",
						remediation: "5x unlock docs/foo.md --force",
						fixable: false,
						detail: { planPath: "docs/foo.md" },
					},
					{
						check: "db",
						status: "ok",
						code: "DB_OK",
						message: "schema v5, integrity ok",
						fixable: false,
					},
				],
				fixed: [],
			}),
		);
		expect(text).toContain(
			"harness-freshness  fail  opencode (project) assets are stale",
		);
		expect(text).toContain("  → 5x harness sync");
		expect(text).toContain(
			"locks              warn  live lock on docs/foo.md (pid 1234)",
		);
		expect(text).toContain("  → 5x unlock docs/foo.md --force");
		expect(text).toContain("db                 ok    schema v5, integrity ok");
	});

	test("prints Fixed: section after findings", () => {
		const text = captureText(() =>
			formatDoctorText({
				ok: true,
				checks: [
					{
						check: "locks",
						status: "ok",
						code: "LOCKS_OK",
						message: "no locks",
						fixable: false,
					},
				],
				fixed: [
					{
						check: "locks",
						code: "LOCK_STALE",
						message: "released stale lock on docs/foo.md",
					},
				],
			}),
		);
		expect(text).toContain("Fixed:");
		expect(text).toContain("LOCK_STALE");
		expect(text).toContain("released stale lock on docs/foo.md");
	});
});

describe("doctorRun envelope", () => {
	test("empty registry emits success envelope with data.ok true", async () => {
		const tmp = makeTmpDir();
		try {
			process.exitCode = 0;
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks: [] }),
			);
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toEqual({ ok: true, checks: [], fixed: [] });
			expect(process.exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("empty registry in text mode prints (none)", async () => {
		const tmp = makeTmpDir();
		try {
			setOutputFormat("text");
			const lines: string[] = [];
			const orig = console.log;
			console.log = (...args: unknown[]) => {
				lines.push(String(args[0]));
			};
			try {
				await doctorRun({ startDir: tmp, checks: [] });
			} finally {
				console.log = orig;
			}
			expect(lines.join("\n")).toBe("(none)");
			expect(process.exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fail findings keep envelope.ok true and set process.exitCode 1", async () => {
		const tmp = makeTmpDir();
		try {
			process.exitCode = 0;
			const checks: DoctorCheck[] = [
				{
					id: "db",
					run: async () => [
						{
							check: "db",
							status: "fail",
							code: "DB_MISSING",
							message: "database file is missing",
							fixable: false,
						},
					],
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks }),
			);
			expect(envelope.ok).toBe(true);
			expect(envelope.data?.ok).toBe(false);
			expect(envelope.data?.checks).toHaveLength(1);
			expect(process.exitCode).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("warn-only findings exit 0", async () => {
		const tmp = makeTmpDir();
		try {
			process.exitCode = 1;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => [
						{
							check: "locks",
							status: "warn",
							code: "LOCK_LIVE",
							message: "live lock",
							fixable: false,
							detail: { planPath: "docs/foo.md" },
						},
					],
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks }),
			);
			expect(envelope.data?.ok).toBe(true);
			expect(process.exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("doctorRun check isolation", () => {
	test("throwing check → CHECK_FAILED finding; sibling checks still run", async () => {
		const tmp = makeTmpDir();
		try {
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => {
						throw new Error("cannot read lock dir");
					},
				},
				{
					id: "db",
					run: async () => [
						{
							check: "db",
							status: "ok",
							code: "DB_OK",
							message: "schema v5, integrity ok",
							fixable: false,
						},
					],
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks }),
			);
			expect(envelope.data?.ok).toBe(false);
			expect(envelope.data?.checks).toHaveLength(2);
			expect(envelope.data?.checks[0]).toMatchObject({
				check: "locks",
				code: "CHECK_FAILED",
				status: "fail",
				fixable: false,
			});
			expect(envelope.data?.checks[0]?.message).toContain(
				"cannot read lock dir",
			);
			expect(envelope.data?.checks[1]).toMatchObject({
				check: "db",
				code: "DB_OK",
				status: "ok",
			});
			expect(process.exitCode).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("doctorRun detect → fix → re-detect", () => {
	test("--fix populates fixed only after re-detect clears the finding by findingKey", async () => {
		const tmp = makeTmpDir();
		try {
			const remaining = new Set(["docs/foo.md"]);
			let fixCalls = 0;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () =>
						[...remaining].map((planPath) => staleFinding(planPath)),
					fix: async (finding) => {
						fixCalls += 1;
						const planPath = (finding.detail as { planPath: string }).planPath;
						if (!remaining.has(planPath)) {
							return { attempted: false, message: "already gone" };
						}
						remaining.delete(planPath);
						return { attempted: true, message: `released ${planPath}` };
					},
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks, fix: true }),
			);
			expect(fixCalls).toBe(1);
			expect(envelope.data?.ok).toBe(true);
			expect(envelope.data?.fixed).toEqual([
				{
					check: "locks",
					code: "LOCK_STALE",
					message: "released docs/foo.md",
				},
			]);
			expect(envelope.data?.checks).toEqual([]);
			expect(process.exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("failed re-detect does not claim fixed", async () => {
		const tmp = makeTmpDir();
		try {
			let fixCalls = 0;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => [staleFinding("docs/foo.md")],
					fix: async () => {
						fixCalls += 1;
						return { attempted: true, message: "released docs/foo.md" };
					},
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks, fix: true }),
			);
			expect(fixCalls).toBe(1);
			expect(envelope.data?.ok).toBe(false);
			expect(envelope.data?.fixed).toEqual([]);
			expect(envelope.data?.checks).toHaveLength(1);
			expect(envelope.data?.checks[0]?.code).toBe("LOCK_STALE");
			expect(process.exitCode).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("two same-code findings with distinct identities both appear in fixed", async () => {
		const tmp = makeTmpDir();
		try {
			const remaining = new Set(["docs/a.md", "docs/b.md"]);
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () =>
						[...remaining].map((planPath) => staleFinding(planPath)),
					fix: async (finding) => {
						const planPath = (finding.detail as { planPath: string }).planPath;
						if (!remaining.has(planPath)) {
							return { attempted: false, message: "already gone" };
						}
						remaining.delete(planPath);
						return { attempted: true, message: `released ${planPath}` };
					},
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks, fix: true }),
			);
			expect(envelope.data?.ok).toBe(true);
			expect(envelope.data?.fixed).toHaveLength(2);
			expect(envelope.data?.fixed.map((f) => f.message).sort()).toEqual([
				"released docs/a.md",
				"released docs/b.md",
			]);
			expect(process.exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fixable unknown code does not call fix, records CHECK_FAILED, sibling checks still run", async () => {
		const tmp = makeTmpDir();
		try {
			let fixCalls = 0;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => [
						{
							check: "locks",
							status: "fail",
							code: "FUTURE_FIXABLE",
							message: "mystery finding",
							fixable: true,
						},
					],
					fix: async () => {
						fixCalls += 1;
						return { attempted: true, message: "should not run" };
					},
				},
				{
					id: "db",
					run: async () => [
						{
							check: "db",
							status: "ok",
							code: "DB_OK",
							message: "schema v5, integrity ok",
							fixable: false,
						},
					],
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks, fix: true }),
			);
			expect(fixCalls).toBe(0);
			expect(envelope.data?.fixed).toEqual([]);
			expect(envelope.data?.ok).toBe(false);
			const codes = envelope.data?.checks.map((f) => f.code) ?? [];
			expect(codes).toContain("CHECK_FAILED");
			expect(codes).toContain("FUTURE_FIXABLE");
			expect(codes).toContain("DB_OK");
			expect(process.exitCode).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("throwing fix → CHECK_FAILED; retained detection; sibling checks still run", async () => {
		const tmp = makeTmpDir();
		try {
			let siblingRan = false;
			let fixCalls = 0;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => [
						staleFinding("docs/foo.md"),
						staleFinding("docs/bar.md"),
					],
					fix: async () => {
						fixCalls += 1;
						throw new Error("unlink EPERM");
					},
				},
				{
					id: "db",
					run: async () => {
						siblingRan = true;
						return [
							{
								check: "db",
								status: "ok",
								code: "DB_OK",
								message: "schema v5, integrity ok",
								fixable: false,
							},
						];
					},
				},
			];
			process.exitCode = 0;
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks, fix: true }),
			);
			expect(fixCalls).toBe(1);
			expect(siblingRan).toBe(true);
			expect(envelope.ok).toBe(true);
			expect(envelope.data?.ok).toBe(false);
			expect(envelope.data?.fixed).toEqual([]);
			const codes = envelope.data?.checks.map((f) => f.code) ?? [];
			expect(codes).toContain("CHECK_FAILED");
			expect(codes.filter((c) => c === "LOCK_STALE")).toHaveLength(2);
			expect(codes).toContain("DB_OK");
			expect(
				envelope.data?.checks.find((f) => f.code === "CHECK_FAILED")?.message,
			).toContain("unlink EPERM");
			expect(process.exitCode).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("without --fix, fix is not called", async () => {
		const tmp = makeTmpDir();
		try {
			let fixCalls = 0;
			const checks: DoctorCheck[] = [
				{
					id: "locks",
					run: async () => [staleFinding("docs/foo.md")],
					fix: async () => {
						fixCalls += 1;
						return { attempted: true, message: "released" };
					},
				},
			];
			const envelope = await captureJson(() =>
				doctorRun({ startDir: tmp, checks }),
			);
			expect(fixCalls).toBe(0);
			expect(envelope.data?.fixed).toEqual([]);
			expect(envelope.data?.checks).toHaveLength(1);
			expect(envelope.data?.ok).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});
