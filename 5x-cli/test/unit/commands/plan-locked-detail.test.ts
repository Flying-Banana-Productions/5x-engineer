import { describe, expect, test } from "bun:test";
import { planLockedDetail } from "../../../src/commands/run-v1.handler.js";
import type { LockInfo } from "../../../src/lock.js";

describe("planLockedDetail", () => {
	test("includes holder, stale, remediation, and retained pid/started_at", () => {
		const lock: LockInfo = {
			pid: 4242,
			startedAt: "2026-08-18T13:00:00.000Z",
			planPath: "/repo/docs/development/foo.md",
		};
		const planPath = "/repo/docs/development/foo.md";
		const detail = planLockedDetail(planPath, lock);

		expect(detail.pid).toBe(4242);
		expect(detail.started_at).toBe("2026-08-18T13:00:00.000Z");
		expect(detail.holder).toEqual({
			pid: 4242,
			startedAt: "2026-08-18T13:00:00.000Z",
		});
		expect(detail.stale).toBe(false);
		expect(detail.remediation).toBe(
			"If this process is hung, run `5x unlock /repo/docs/development/foo.md --force`.",
		);
	});
});
