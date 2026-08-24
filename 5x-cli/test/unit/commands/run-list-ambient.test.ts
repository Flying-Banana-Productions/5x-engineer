/**
 * Unit tests for `run list` ambient marker stamping.
 *
 * Pure payload transform — no CLI, no console capture.
 */

import { describe, expect, test } from "bun:test";
import type { AmbientRunResult } from "../../../src/commands/run-identity.js";
import {
	applyAmbientListMarker,
	type ListRunRow,
} from "../../../src/commands/run-v1.handler.js";

function row(id: string, status = "active"): ListRunRow {
	return {
		id,
		plan_path: `/tmp/${id}.md`,
		status,
		created_at: "2026-08-24T00:00:00Z",
		updated_at: "2026-08-24T00:00:00Z",
		step_count: 0,
	};
}

describe("applyAmbientListMarker", () => {
	test("stamps exactly one focused run with source", () => {
		const runs = [row("run_aaaaaaa01"), row("run_bbbbbbb02")];
		const ambient: AmbientRunResult = {
			ok: true,
			runId: "run_bbbbbbb02",
			source: "worktree",
		};
		applyAmbientListMarker(runs, ambient);
		expect(runs[0]?.ambient).toBeUndefined();
		expect(runs[0]?.ambient_source).toBeUndefined();
		expect(runs[1]?.ambient).toBe(true);
		expect(runs[1]?.ambient_source).toBe("worktree");
	});

	test("does not add ambient: false on others", () => {
		const runs = [row("run_aaaaaaa01"), row("run_bbbbbbb02")];
		applyAmbientListMarker(runs, {
			ok: true,
			runId: "run_aaaaaaa01",
			source: "pointer",
		});
		expect("ambient" in (runs[1] ?? {})).toBe(false);
	});

	test("source none / missing runId leaves payload unmarked", () => {
		const runs = [row("run_aaaaaaa01")];
		applyAmbientListMarker(runs, {
			ok: true,
			runId: undefined,
			source: "none",
		});
		expect(runs[0]?.ambient).toBeUndefined();
	});

	test("resolution failure leaves payload unmarked", () => {
		const runs = [row("run_aaaaaaa01"), row("run_bbbbbbb02")];
		applyAmbientListMarker(runs, {
			ok: false,
			error: {
				code: "RUN_CONTEXT_AMBIGUOUS",
				message: "Multiple active runs",
				detail: { candidates: ["run_aaaaaaa01", "run_bbbbbbb02"] },
			},
		});
		expect(runs.every((r) => r.ambient === undefined)).toBe(true);
	});

	test("flag and pipe sources are not advertised", () => {
		const flagged = [row("run_aaaaaaa01")];
		applyAmbientListMarker(flagged, {
			ok: true,
			runId: "run_aaaaaaa01",
			source: "flag",
		});
		expect(flagged[0]?.ambient).toBeUndefined();

		const piped = [row("run_aaaaaaa01")];
		applyAmbientListMarker(piped, {
			ok: true,
			runId: "run_aaaaaaa01",
			source: "pipe",
		});
		expect(piped[0]?.ambient).toBeUndefined();
	});

	test("completed run can still be marked (status unchanged)", () => {
		const runs = [row("run_doneaaaa01", "completed"), row("run_actveaaa02")];
		applyAmbientListMarker(runs, {
			ok: true,
			runId: "run_doneaaaa01",
			source: "environment",
		});
		expect(runs[0]?.status).toBe("completed");
		expect(runs[0]?.ambient).toBe(true);
		expect(runs[0]?.ambient_source).toBe("environment");
		expect(runs[1]?.ambient).toBeUndefined();
	});

	test("focused id not in the filtered list → no marker", () => {
		const runs = [row("run_listedaa01")];
		applyAmbientListMarker(runs, {
			ok: true,
			runId: "run_otheraaa02",
			source: "pointer",
		});
		expect(runs[0]?.ambient).toBeUndefined();
	});
});
