/**
 * Unit tests for lock list / unlock handlers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockList, unlockPlan } from "../../../src/commands/lock.handler.js";
import { acquireLock } from "../../../src/lock.js";
import { CliError, setOutputFormat } from "../../../src/output.js";
import { canonicalizePlanPath } from "../../../src/paths.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-lock-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function canonicalLockPath(projectRoot: string, planPath: string): string {
	const canonical = canonicalizePlanPath(planPath);
	const hash = createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 16);
	return join(projectRoot, ".5x", "locks", `${hash}.lock`);
}

async function captureJson(fn: () => Promise<void>): Promise<{
	ok: boolean;
	data?: Record<string, unknown>;
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
	return JSON.parse(raw) as { ok: boolean; data?: Record<string, unknown> };
}

const DEAD_PID = 99999999;

afterEach(() => {
	setOutputFormat("json");
});

describe("lockList", () => {
	test("empty project returns { locks: [] }", async () => {
		const tmp = makeTmpDir();
		try {
			const envelope = await captureJson(() => lockList({ startDir: tmp }));
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toEqual({ locks: [] });
		} finally {
			cleanupDir(tmp);
		}
	});

	test("empty list prints (none) in text mode", async () => {
		const tmp = makeTmpDir();
		try {
			setOutputFormat("text");
			const lines: string[] = [];
			const orig = console.log;
			console.log = (...args: unknown[]) => {
				lines.push(String(args[0]));
			};
			try {
				await lockList({ startDir: tmp });
			} finally {
				console.log = orig;
			}
			expect(lines.join("\n")).toBe("(none)");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("classifies live/stale/corrupt and exposes lock_path on corrupt rows", async () => {
		const tmp = makeTmpDir();
		try {
			const livePlan = join(tmp, "docs", "development", "live.md");
			const stalePlan = join(tmp, "docs", "development", "stale.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(livePlan, "# live\n");
			writeFileSync(stalePlan, "# stale\n");

			acquireLock(tmp, livePlan);
			const stalePath = canonicalLockPath(tmp, stalePlan);
			mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
			writeFileSync(
				stalePath,
				JSON.stringify({
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(stalePlan),
				}),
			);
			const corruptPath = join(tmp, ".5x", "locks", "orphan.lock");
			writeFileSync(corruptPath, "not-json");

			const envelope = await captureJson(() => lockList({ startDir: tmp }));
			const locks = envelope.data?.locks as Array<Record<string, unknown>>;
			expect(locks).toHaveLength(3);

			const live = locks.find((l) => l.liveness === "live");
			expect(live?.pid).toBe(process.pid);
			expect(live?.plan_path).toBe(canonicalizePlanPath(livePlan));

			const stale = locks.find((l) => l.liveness === "stale");
			expect(stale?.pid).toBe(DEAD_PID);
			expect(stale?.plan_path).toBe(canonicalizePlanPath(stalePlan));

			const corrupt = locks.find((l) => l.liveness === "corrupt");
			expect(corrupt?.plan_path).toBeNull();
			expect(corrupt?.pid).toBeNull();
			expect(corrupt?.lock_path).toBe(corruptPath);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("text mode prints liveness lines and remediation", async () => {
		const tmp = makeTmpDir();
		try {
			const stalePlan = join(tmp, "docs", "development", "stale.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(stalePlan, "# stale\n");
			const stalePath = canonicalLockPath(tmp, stalePlan);
			mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
			writeFileSync(
				stalePath,
				JSON.stringify({
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(stalePlan),
				}),
			);
			writeFileSync(join(tmp, ".5x", "locks", "orphan.lock"), "not-json");

			setOutputFormat("text");
			const lines: string[] = [];
			const orig = console.log;
			console.log = (...args: unknown[]) => {
				lines.push(String(args[0]));
			};
			try {
				await lockList({ startDir: tmp });
			} finally {
				console.log = orig;
			}
			const output = lines.join("\n");
			expect(output).toContain("stale  pid=");
			expect(output).toContain("corrupt  lock_path=");
			expect(output).toContain("5x unlock");
			expect(output).toContain("5x doctor --fix");
			expect(output).not.toContain('"ok"');
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("unlockPlan", () => {
	test("reports not_locked when no lock exists", async () => {
		const tmp = makeTmpDir();
		try {
			const plan = join(tmp, "docs", "development", "foo.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(plan, "# plan\n");
			const envelope = await captureJson(() =>
				unlockPlan({ plan, startDir: tmp }),
			);
			expect(envelope).toEqual({
				ok: true,
				data: { released: false, reason: "not_locked" },
			});
		} finally {
			cleanupDir(tmp);
		}
	});

	test("safe unlock releases a stale lock", async () => {
		const tmp = makeTmpDir();
		try {
			const plan = join(tmp, "docs", "development", "foo.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(plan, "# plan\n");
			const lockPath = canonicalLockPath(tmp, plan);
			mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(plan),
				}),
			);

			const envelope = await captureJson(() =>
				unlockPlan({ plan, startDir: tmp }),
			);
			expect(envelope.data?.released).toBe(true);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("safe unlock releases a canonical-path corrupt lock", async () => {
		const tmp = makeTmpDir();
		try {
			const plan = join(tmp, "docs", "development", "foo.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(plan, "# plan\n");
			const lockPath = canonicalLockPath(tmp, plan);
			mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
			writeFileSync(lockPath, "not-json");

			const envelope = await captureJson(() =>
				unlockPlan({ plan, startDir: tmp }),
			);
			expect(envelope.data?.released).toBe(true);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("refuses a live holder without --force", async () => {
		const tmp = makeTmpDir();
		try {
			const plan = join(tmp, "docs", "development", "foo.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(plan, "# plan\n");
			acquireLock(tmp, plan);

			try {
				await unlockPlan({ plan, startDir: tmp });
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				const cli = err as CliError;
				expect(cli.code).toBe("PLAN_LOCKED");
				expect(cli.exitCode).toBe(4);
				const detail = cli.detail as Record<string, unknown>;
				expect(detail.pid).toBe(process.pid);
				expect(detail.holder).toEqual({
					pid: process.pid,
					startedAt: expect.any(String),
				});
				expect(detail.stale).toBe(false);
				expect(String(detail.remediation)).toContain("5x unlock");
				expect(String(detail.remediation)).toContain("--force");
			}
			expect(existsSync(canonicalLockPath(tmp, plan))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("force overrides a live holder and returns previous_holder", async () => {
		const tmp = makeTmpDir();
		try {
			const plan = join(tmp, "docs", "development", "foo.md");
			mkdirSync(join(tmp, "docs", "development"), { recursive: true });
			writeFileSync(plan, "# plan\n");
			acquireLock(tmp, plan);

			const envelope = await captureJson(() =>
				unlockPlan({ plan, force: true, startDir: tmp }),
			);
			expect(envelope.data?.released).toBe(true);
			expect(envelope.data?.forced).toBe(true);
			const holder = envelope.data?.previous_holder as Record<string, unknown>;
			expect(holder.pid).toBe(process.pid);
			expect(holder.planPath).toBe(canonicalizePlanPath(plan));
			expect(typeof holder.startedAt).toBe("string");
			expect(existsSync(canonicalLockPath(tmp, plan))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});
