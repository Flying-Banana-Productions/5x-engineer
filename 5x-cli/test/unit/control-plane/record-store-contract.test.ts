import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryRecordStore,
	createWorkingTreeRecordStore,
	type PreparedRecordStep,
	type PrepareRecordStepOutcome,
	RECORD_LINE_SCHEMA_VERSION,
	type RecordCommandContext,
	type RecordLine,
	type RecordOrigin,
	type RecordPerformer,
	type RecordRecorder,
	type RecordStore,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import type { MemoryRecordStoreOptions } from "../../../src/control-plane/record-memory.js";
import type {
	PreparedRecordStep as PublicPreparedRecordStep,
	PrepareRecordStepOutcome as PublicPrepareRecordStepOutcome,
	RecordCommandContext as PublicRecordCommandContext,
} from "../../../src/index.js";

const FIXED_NOW = "2026-09-03 12:00:00";
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTALLATION_ID = randomUUID();

/** Fixture origin factory matching the Phase 1 freeze shape of `originFor`. */
function originFor(performer: RecordPerformer): RecordOrigin {
	return {
		recorder: { installation_id: INSTALLATION_ID, actor: "test-operator" },
		performer,
	};
}

const FIXTURE_ORIGIN = originFor({
	kind: "agent",
	role: "reviewer",
	provider: "opencode",
});

const EXPORTER_ORIGIN = originFor({ kind: "system", role: "exporter" });

function v1Summary(
	id: string,
	overrides: Partial<RunRecordSummary> = {},
): RunRecordSummary {
	return {
		id,
		plan_path: "docs/development/plans/sample-plan.md",
		config_json: null,
		created_at: FIXED_NOW,
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: { installation_id: INSTALLATION_ID, actor: "test-operator" },
		...overrides,
	};
}

function stepPayload(name: string, result: unknown = { ok: true }) {
	return {
		step_name: name,
		phase: null,
		iteration: 1,
		result_json: result,
		head_commit: "abc123",
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`expected RecordStoreError ${code}`);
	} catch (err) {
		expect(err).toBeInstanceOf(RecordStoreError);
		expect((err as RecordStoreError).code).toBe(code);
	}
}

/**
 * Shared RecordStore contract. Phase 1 registers memory only. Phase 3 adds a
 * working-tree harness to the same factory.
 */
export function runRecordStoreContract(setup: () => RecordStore): void {
	test("putRun / getRun round-trip then seal preserves creator and sets sealer", () => {
		const store = setup();
		const creator = {
			installation_id: INSTALLATION_ID,
			actor: "test-operator",
		};
		store.putRun(v1Summary("run_seal", { creator }));
		const loaded = store.getRun("run_seal");
		expect(loaded).not.toBeNull();
		expect(loaded?.sealed_at).toBeNull();
		expect(loaded?.status).toBe("active");
		expect(loaded?.creator).toEqual(creator);
		expect(loaded?.sealer).toBeUndefined();
		expect(loaded?.format_version).toBe(RUN_RECORD_FORMAT_VERSION);

		const sealer = { installation_id: randomUUID(), actor: "sealer" };
		store.putRun(
			v1Summary("run_seal", {
				creator,
				sealer,
				sealed_at: "2026-09-03 13:00:00",
				status: "completed",
				final_head_commit: "def456",
			}),
		);
		const sealed = store.getRun("run_seal");
		expect(sealed?.creator).toEqual(creator);
		expect(sealed?.sealer).toEqual(sealer);
		expect(sealed?.sealed_at).toBe("2026-09-03 13:00:00");
		expect(sealed?.status).toBe("completed");
	});

	test("seal of creator: null copies null and does not copy materializer into creator or sealer", () => {
		const store = setup();
		store.putRun(
			v1Summary("run_unknown", {
				creator: null,
				materializer: EXPORTER_ORIGIN,
				backfilled: true,
			}),
		);
		const sealer = { installation_id: INSTALLATION_ID, actor: "sealer" };
		store.putRun(
			v1Summary("run_unknown", {
				creator: null,
				sealer,
				sealed_at: "2026-09-03 13:00:00",
				status: "completed",
			}),
		);
		const sealed = store.getRun("run_unknown");
		expect(sealed?.creator).toBeNull();
		expect(sealed?.sealer).toEqual(sealer);
		expect(sealed?.materializer).toBeUndefined();
	});

	test("putRun preserves a known creator when a later write tries to replace it", () => {
		const store = setup();
		const creator = {
			installation_id: INSTALLATION_ID,
			actor: "test-operator",
		};
		store.putRun(v1Summary("run_creator", { creator }));
		const impostor = {
			installation_id: randomUUID(),
			actor: "impostor",
		};
		const sealer = { installation_id: randomUUID(), actor: "sealer" };
		store.putRun(
			v1Summary("run_creator", {
				creator: impostor,
				sealer,
				sealed_at: "2026-09-03 13:00:00",
				status: "completed",
			}),
		);
		const sealed = store.getRun("run_creator");
		expect(sealed?.creator).toEqual(creator);
		expect(sealed?.creator).not.toEqual(impostor);
		expect(sealed?.sealer).toEqual(sealer);
	});

	test("putRun preserves a null creator when a later write tries to replace it", () => {
		const store = setup();
		store.putRun(
			v1Summary("run_null_creator", {
				creator: null,
				materializer: EXPORTER_ORIGIN,
				backfilled: true,
			}),
		);
		const impostor = {
			installation_id: INSTALLATION_ID,
			actor: "impostor",
		};
		const sealer = { installation_id: INSTALLATION_ID, actor: "sealer" };
		store.putRun(
			v1Summary("run_null_creator", {
				creator: impostor,
				sealer,
				sealed_at: "2026-09-03 13:00:00",
				status: "completed",
			}),
		);
		const sealed = store.getRun("run_null_creator");
		expect(sealed?.creator).toBeNull();
		expect(sealed?.sealer).toEqual(sealer);
	});

	test("putRun of format_version > 1 is refused; getRun still returns the newer summary", () => {
		const store = setup();
		store.putRun(v1Summary("run_v2"));
		store.putRun(v1Summary("run_v2", { format_version: 2 }));
		expect(store.getRun("run_v2")?.format_version).toBe(2);

		expectCode(
			() =>
				store.putRun(
					v1Summary("run_v2", {
						status: "completed",
						sealed_at: "2026-09-03 13:00:00",
					}),
				),
			"UNSUPPORTED_FORMAT_VERSION",
		);
		expect(store.getRun("run_v2")?.format_version).toBe(2);
		expect(store.getRun("run_v2")?.status).toBe("active");
	});

	test("listRuns and listRuns({ planSlug }) filter by planSlugFromPath", () => {
		const store = setup();
		store.putRun(
			v1Summary("run_alpha", {
				plan_path: "docs/development/plans/alpha-plan.md",
			}),
		);
		store.putRun(
			v1Summary("run_beta", {
				plan_path: "docs/development/plans/beta-plan.md",
			}),
		);
		store.putRun(
			v1Summary("run_alpha_2", {
				plan_path: "docs/development/plans/alpha-plan.md",
			}),
		);

		const all = store.listRuns();
		expect(all.map((r) => r.id).sort()).toEqual([
			"run_alpha",
			"run_alpha_2",
			"run_beta",
		]);

		const alpha = store.listRuns({ planSlug: "alpha-plan" });
		expect(alpha.map((r) => r.id).sort()).toEqual(["run_alpha", "run_alpha_2"]);
		expect(store.listRuns({ planSlug: "missing-plan" })).toEqual([]);
	});

	test("step append then getLine by stepIdempotencyKey; duplicate keeps original payload and origin", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const key = stepIdempotencyKey({
			runId: "run_1",
			stepName: "git:commit",
			phase: "1",
			iteration: 1,
		});
		const first = store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: key,
			payload: stepPayload("git:commit", { sha: "aaa" }),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		expect(first.created).toBe(true);
		expect(first.line.origin).toEqual(FIXTURE_ORIGIN);

		const otherOrigin = originFor({ kind: "human", role: "operator" });
		const dup = store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: key,
			payload: stepPayload("git:commit", { sha: "bbb" }),
			...recordedEnvelope(otherOrigin),
		});
		expect(dup.created).toBe(false);
		expect(dup.line.payload).toEqual(stepPayload("git:commit", { sha: "aaa" }));
		expect(dup.line.origin).toEqual(FIXTURE_ORIGIN);

		const loaded = store.getLine("run_1", "steps", key);
		expect(loaded).toEqual(first.line);
		expect(loaded?.origin).toEqual(FIXTURE_ORIGIN);
	});

	test("listLines(steps) preserves insertion order when createdAt is equal", () => {
		const store = setup();
		store.putRun(v1Summary("run_order"));
		const firstKey = stepIdempotencyKey({
			runId: "run_order",
			stepName: "a",
			phase: null,
			iteration: 1,
		});
		const secondKey = stepIdempotencyKey({
			runId: "run_order",
			stepName: "b",
			phase: null,
			iteration: 1,
		});
		store.append({
			runId: "run_order",
			stream: "steps",
			idempotencyKey: firstKey,
			payload: stepPayload("a"),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		store.append({
			runId: "run_order",
			stream: "steps",
			idempotencyKey: secondKey,
			payload: stepPayload("b"),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		const lines = store.listLines("run_order", "steps");
		expect(lines.map((l) => l.idempotencyKey)).toEqual([firstKey, secondKey]);
		expect(lines[0]?.createdAt).toBe(lines[1]?.createdAt);
	});

	test("budget stream append/get/list, duplicate CAS, origin round-trips", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const op = {
			runId: "run_1",
			stream: "budget" as const,
			idempotencyKey: "budget:baseline:run_1",
			payload: { b0: 4 },
			...recordedEnvelope(FIXTURE_ORIGIN),
		};
		const first = store.append(op);
		expect(first.created).toBe(true);
		expect(first.line.origin).toEqual(FIXTURE_ORIGIN);
		expect(first.line.payload).toEqual({ b0: 4 });

		const dup = store.append({ ...op, payload: { b0: 99 } });
		expect(dup.created).toBe(false);
		expect(dup.line.payload).toEqual({ b0: 4 });
		expect(dup.line.origin).toEqual(FIXTURE_ORIGIN);

		expect(
			store.getLine("run_1", "budget", "budget:baseline:run_1")?.origin,
		).toEqual(FIXTURE_ORIGIN);
		expect(store.listLines("run_1", "budget")).toHaveLength(1);
	});

	test("decisions stream opaque payload and origin round-trips", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const humanOrigin = originFor({ kind: "human", role: "operator" });
		const first = store.append({
			runId: "run_1",
			stream: "decisions",
			idempotencyKey: "decision:prompt:abc",
			payload: { prompt_id: "abc", answer: "ship it" },
			...recordedEnvelope(humanOrigin),
		});
		expect(first.created).toBe(true);
		expect(first.line.origin).toEqual(humanOrigin);
		expect(
			store.getLine("run_1", "decisions", "decision:prompt:abc")?.payload,
		).toEqual({ prompt_id: "abc", answer: "ship it" });
		expect(store.listLines("run_1", "decisions")).toHaveLength(1);
	});

	test("atomicAppend([step, budget]) both created; shared origin fixture", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const stepKey = stepIdempotencyKey({
			runId: "run_1",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
		});
		const results = store.atomicAppend([
			{
				runId: "run_1",
				stream: "steps",
				idempotencyKey: stepKey,
				payload: stepPayload("reviewer:plan"),
				...recordedEnvelope(FIXTURE_ORIGIN),
			},
			{
				runId: "run_1",
				stream: "budget",
				idempotencyKey: "budget:snapshot:reviewer:plan:1",
				payload: { remaining: 3 },
				...recordedEnvelope(FIXTURE_ORIGIN),
			},
		]);
		expect(results.map((r) => r.created)).toEqual([true, true]);
		expect(store.getLine("run_1", "steps", stepKey)?.origin).toEqual(
			FIXTURE_ORIGIN,
		);
		expect(
			store.getLine("run_1", "budget", "budget:snapshot:reviewer:plan:1")
				?.origin,
		).toEqual(FIXTURE_ORIGIN);
	});

	test("atomicAppend with existing step key: step created false, budget still appended", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const stepKey = stepIdempotencyKey({
			runId: "run_1",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
		});
		store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: stepKey,
			payload: stepPayload("reviewer:plan", { first: true }),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		const results = store.atomicAppend([
			{
				runId: "run_1",
				stream: "steps",
				idempotencyKey: stepKey,
				payload: stepPayload("reviewer:plan", { first: false }),
				...recordedEnvelope(FIXTURE_ORIGIN),
			},
			{
				runId: "run_1",
				stream: "budget",
				idempotencyKey: "budget:snapshot:late",
				payload: { remaining: 2 },
				...recordedEnvelope(FIXTURE_ORIGIN),
			},
		]);
		expect(results[0]?.created).toBe(false);
		expect(results[0]?.line.payload).toEqual(
			stepPayload("reviewer:plan", { first: true }),
		);
		expect(results[1]?.created).toBe(true);
		expect(
			store.getLine("run_1", "budget", "budget:snapshot:late"),
		).not.toBeNull();
	});

	test("atomicAppend throw on a later op leaves no lines", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const stepKey = stepIdempotencyKey({
			runId: "run_1",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
		});
		expectCode(
			() =>
				store.atomicAppend([
					{
						runId: "run_1",
						stream: "steps",
						idempotencyKey: stepKey,
						payload: stepPayload("reviewer:plan"),
						...recordedEnvelope(FIXTURE_ORIGIN),
					},
					{
						runId: "run_1",
						stream: "budget",
						idempotencyKey: "budget:snapshot:throw",
						payload: { remaining: 3 },
						schemaVersion: RECORD_LINE_SCHEMA_VERSION,
						provenance: "recorded",
						origin: null,
					},
				]),
			"INVALID_ORIGIN",
		);
		expect(store.getLine("run_1", "steps", stepKey)).toBeNull();
		expect(store.listLines("run_1", "budget")).toEqual([]);
	});

	test("atomicAppend([]) returns [] and writes nothing", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		expect(store.atomicAppend([])).toEqual([]);
		expect(store.listLines("run_1", "steps")).toEqual([]);
	});

	test("atomicAppend of mixed runIds throws INVALID_ATOMIC_APPEND and mutates nothing", () => {
		const store = setup();
		store.putRun(v1Summary("run_a"));
		store.putRun(v1Summary("run_b"));
		const keyA = stepIdempotencyKey({
			runId: "run_a",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		const keyB = stepIdempotencyKey({
			runId: "run_b",
			stepName: "y",
			phase: null,
			iteration: 1,
		});
		expectCode(
			() =>
				store.atomicAppend([
					{
						runId: "run_a",
						stream: "steps",
						idempotencyKey: keyA,
						payload: stepPayload("x"),
						...recordedEnvelope(FIXTURE_ORIGIN),
					},
					{
						runId: "run_b",
						stream: "steps",
						idempotencyKey: keyB,
						payload: stepPayload("y"),
						...recordedEnvelope(FIXTURE_ORIGIN),
					},
				]),
			"INVALID_ATOMIC_APPEND",
		);
		expect(store.getLine("run_a", "steps", keyA)).toBeNull();
		expect(store.getLine("run_b", "steps", keyB)).toBeNull();
		expect(store.listLines("run_a", "steps")).toEqual([]);
		expect(store.listLines("run_b", "steps")).toEqual([]);
	});

	test("append without putRun throws RUN_NOT_FOUND", () => {
		const store = setup();
		expectCode(
			() =>
				store.append({
					runId: "missing",
					stream: "steps",
					idempotencyKey: "step:missing:x::1",
					payload: stepPayload("x"),
					...recordedEnvelope(FIXTURE_ORIGIN),
				}),
			"RUN_NOT_FOUND",
		);
	});

	test("missing getLine / getRun return null", () => {
		const store = setup();
		expect(store.getRun("missing")).toBeNull();
		store.putRun(v1Summary("run_1"));
		expect(store.getLine("run_1", "steps", "no-such-key")).toBeNull();
	});

	test("getLine against a run that was never putRun throws RUN_NOT_FOUND", () => {
		const store = setup();
		expectCode(() => store.getLine("missing", "steps", "k"), "RUN_NOT_FOUND");
	});

	test("recorded append with origin: null or materializer throws INVALID_ORIGIN", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		expectCode(
			() =>
				store.append({
					runId: "run_1",
					stream: "steps",
					idempotencyKey: "step:run_1:x::1",
					payload: stepPayload("x"),
					schemaVersion: RECORD_LINE_SCHEMA_VERSION,
					provenance: "recorded",
					origin: null,
				}),
			"INVALID_ORIGIN",
		);
		expectCode(
			() =>
				store.append({
					runId: "run_1",
					stream: "steps",
					idempotencyKey: "step:run_1:y::1",
					payload: stepPayload("y"),
					...recordedEnvelope(FIXTURE_ORIGIN),
					materializer: EXPORTER_ORIGIN,
				}),
			"INVALID_ORIGIN",
		);
		expect(store.listLines("run_1", "steps")).toEqual([]);
	});

	test("backfilled append with origin: null and materializer round-trips; materializer is not origin", () => {
		const store = setup();
		store.putRun(v1Summary("run_1", { creator: null }));
		const result = store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: "step:run_1:backfill::1",
			payload: stepPayload("backfill"),
			schemaVersion: RECORD_LINE_SCHEMA_VERSION,
			provenance: "backfilled",
			origin: null,
			materializer: EXPORTER_ORIGIN,
		});
		expect(result.created).toBe(true);
		expect(result.line.origin).toBeNull();
		expect(result.line.materializer).toEqual(EXPORTER_ORIGIN);
		expect(result.line.provenance).toBe("backfilled");

		const loaded = store.getLine("run_1", "steps", "step:run_1:backfill::1");
		expect(loaded?.origin).toBeNull();
		expect(loaded?.materializer).toEqual(EXPORTER_ORIGIN);
	});

	test("fixture origin uses a random UUID and optional actor; no hostname/username/session_id", () => {
		expect(FIXTURE_ORIGIN.recorder.installation_id).toMatch(UUID_RE);
		expect(FIXTURE_ORIGIN.recorder.actor).toBe("test-operator");
		expect(FIXTURE_ORIGIN).not.toHaveProperty("hostname");
		expect(FIXTURE_ORIGIN).not.toHaveProperty("username");
		expect(FIXTURE_ORIGIN).not.toHaveProperty("session_id");
		expect(FIXTURE_ORIGIN.recorder).not.toHaveProperty("hostname");
		expect(FIXTURE_ORIGIN.recorder).not.toHaveProperty("username");
		expect(FIXTURE_ORIGIN.recorder).not.toHaveProperty("session_id");
		const serialized = JSON.stringify(FIXTURE_ORIGIN);
		expect(serialized).not.toContain("hostname");
		expect(serialized).not.toContain("username");
		expect(serialized).not.toContain("session_id");
	});

	test("putRun does not touch streams", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const key = stepIdempotencyKey({
			runId: "run_1",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: key,
			payload: stepPayload("x"),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		store.putRun(
			v1Summary("run_1", {
				status: "completed",
				sealed_at: "2026-09-03 13:00:00",
				sealer: { installation_id: INSTALLATION_ID },
			}),
		);
		expect(store.getLine("run_1", "steps", key)).not.toBeNull();
		expect(store.listLines("run_1", "steps")).toHaveLength(1);
	});

	test("mutating a getLine / getRun result does not change the store", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const key = stepIdempotencyKey({
			runId: "run_1",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		store.append({
			runId: "run_1",
			stream: "steps",
			idempotencyKey: key,
			payload: { nested: { n: 1 } },
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		const line = store.getLine("run_1", "steps", key) as RecordLine;
		(line.payload as { nested: { n: number } }).nested.n = 99;
		if (line.origin) line.origin.recorder.actor = "mutated";
		const storedLine = store.getLine("run_1", "steps", key);
		expect(storedLine).not.toBeNull();
		if (!storedLine) return;
		expect((storedLine.payload as { nested: { n: number } }).nested.n).toBe(1);
		expect(storedLine.origin?.recorder.actor).toBe("test-operator");

		const summary = store.getRun("run_1");
		expect(summary).not.toBeNull();
		if (summary) {
			summary.status = "aborted";
			if (summary.creator) summary.creator.actor = "mutated";
		}
		expect(store.getRun("run_1")?.status).toBe("active");
		expect(store.getRun("run_1")?.creator?.actor).toBe("test-operator");
	});

	test("omitted schemaVersion defaults to RECORD_LINE_SCHEMA_VERSION", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		const result = store.append({
			runId: "run_1",
			stream: "budget",
			idempotencyKey: "budget:no-version",
			payload: { ok: true },
			provenance: "recorded",
			origin: FIXTURE_ORIGIN,
		});
		expect(result.line.schemaVersion).toBe(RECORD_LINE_SCHEMA_VERSION);
	});

	test("INVALID_STREAM is thrown for an unknown stream name", () => {
		const store = setup();
		store.putRun(v1Summary("run_1"));
		expectCode(
			() =>
				store.append({
					runId: "run_1",
					stream: "nope" as RecordLine["stream"],
					idempotencyKey: "x",
					payload: {},
					...recordedEnvelope(FIXTURE_ORIGIN),
				}),
			"INVALID_STREAM",
		);
	});
}

describe("RecordStore contract (memory)", () => {
	runRecordStoreContract(() =>
		createMemoryRecordStore({ now: () => FIXED_NOW }),
	);
});

describe("RecordStore contract (working-tree)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	runRecordStoreContract(() => {
		const dir = mkdtempSync(join(tmpdir(), "5x-rec-wt-"));
		dirs.push(dir);
		return createWorkingTreeRecordStore({
			recordsRoot: dir,
			now: () => FIXED_NOW,
			fsyncFile: () => {},
			fsyncDir: () => {},
			onWarn: () => {},
		});
	});

	test("append writes one JSONL line on disk and getLine returns directory runId", () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-rec-wt-disk-"));
		dirs.push(dir);
		const store = createWorkingTreeRecordStore({
			recordsRoot: dir,
			now: () => FIXED_NOW,
			fsyncFile: () => {},
			fsyncDir: () => {},
			onWarn: () => {},
		});
		store.putRun(v1Summary("run_disk"));
		const key = stepIdempotencyKey({
			runId: "run_disk",
			stepName: "x",
			phase: null,
			iteration: 1,
		});
		store.append({
			runId: "run_disk",
			stream: "steps",
			idempotencyKey: key,
			payload: stepPayload("x"),
			...recordedEnvelope(FIXTURE_ORIGIN),
		});
		const files = [join(dir, "sample-plan", "run_disk", "steps.jsonl")];
		expect(existsSync(files[0] ?? "")).toBe(true);
		const text = readFileSync(files[0] ?? "", "utf8");
		expect(text.trim().split("\n")).toHaveLength(1);
		expect(() => JSON.parse(text.trim())).not.toThrow();
		expect(store.getLine("run_disk", "steps", key)?.runId).toBe("run_disk");
	});
});

describe("createMemoryRecordStore onBeforeCommit", () => {
	test("throw after clone apply skips swap; original is intact", () => {
		const opts: MemoryRecordStoreOptions = {
			now: () => FIXED_NOW,
			onBeforeCommit: () => {
				throw new Error("commit aborted");
			},
		};
		const store = createMemoryRecordStore(opts);
		store.putRun(v1Summary("run_1"));
		const stepKey = stepIdempotencyKey({
			runId: "run_1",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
		});
		expect(() =>
			store.atomicAppend([
				{
					runId: "run_1",
					stream: "steps",
					idempotencyKey: stepKey,
					payload: stepPayload("reviewer:plan"),
					...recordedEnvelope(FIXTURE_ORIGIN),
				},
				{
					runId: "run_1",
					stream: "budget",
					idempotencyKey: "budget:snapshot:x",
					payload: { remaining: 3 },
					...recordedEnvelope(FIXTURE_ORIGIN),
				},
			]),
		).toThrow("commit aborted");
		expect(store.getLine("run_1", "steps", stepKey)).toBeNull();
		expect(store.listLines("run_1", "budget")).toEqual([]);
		expect(store.getRun("run_1")?.status).toBe("active");
	});
});

describe("recordedEnvelope and stepIdempotencyKey", () => {
	test("recordedEnvelope stamps schema version, recorded provenance, and origin", () => {
		const envelope = recordedEnvelope(FIXTURE_ORIGIN);
		expect(envelope).toEqual({
			schemaVersion: RECORD_LINE_SCHEMA_VERSION,
			provenance: "recorded",
			origin: FIXTURE_ORIGIN,
		});
	});

	test("stepIdempotencyKey encodes null phase as empty and is the lookup key", () => {
		expect(
			stepIdempotencyKey({
				runId: "run_1",
				stepName: "git:commit",
				phase: null,
				iteration: 2,
			}),
		).toBe("step:run_1:git:commit::2");
		expect(
			stepIdempotencyKey({
				runId: "run_1",
				stepName: "git:commit",
				phase: "1",
				iteration: 2,
			}),
		).toBe("step:run_1:git:commit:1:2");
	});
});

describe("Phase 1 freeze boundary", () => {
	test("record modules do not import the later context factory", () => {
		const files = [
			join(import.meta.dir, "../../../src/control-plane/record-types.ts"),
			join(import.meta.dir, "../../../src/control-plane/record-store.ts"),
			join(import.meta.dir, "../../../src/control-plane/record-memory.ts"),
			join(
				import.meta.dir,
				"../../../src/control-plane/record-writer-types.ts",
			),
			join(import.meta.dir, "../../../src/control-plane/index.ts"),
			join(import.meta.dir, "record-store-contract.test.ts"),
		];
		const factoryName = ["create", "Record", "Context"].join("");
		const modulePath = ["record", "-", "context"].join("");
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text.includes(factoryName)).toBe(false);
			expect(text.includes(modulePath)).toBe(false);
		}
		const factoryFile = join(
			import.meta.dir,
			"../../../src/commands",
			`${modulePath}.ts`,
		);
		expect(existsSync(factoryFile)).toBe(true);
	});
});

/**
 * Compilation-oriented Slice 06 consumption: a review-budget wrapper can
 * extend `RecordCommandContext`, keep `prepared.performer`, and stamp both
 * ops via `originFor` without a later factory module.
 */
function stampPairedOps(
	ctx: RecordCommandContext,
	prepared: PreparedRecordStep,
): ReturnType<typeof recordedEnvelope>[] {
	const origin = ctx.originFor(prepared.performer);
	return [recordedEnvelope(origin), recordedEnvelope(origin)];
}

function fixtureWriterContext(
	originForImpl: (performer: RecordPerformer) => RecordOrigin,
	recorder: RecordRecorder,
): RecordCommandContext {
	return {
		db: {} as RecordCommandContext["db"],
		config: {} as RecordCommandContext["config"],
		recordStore: createMemoryRecordStore(),
		recordsRelPath: "docs/development/runs",
		recordsAbsPath: "/tmp/docs/development/runs",
		executionContext: {
			controlPlaneRoot: "/tmp",
			run: {
				id: "run_1",
				plan_path: "docs/development/plans/p.md",
				status: "active",
			},
			mappedWorktreePath: null,
			effectiveWorkingDirectory: "/tmp",
			effectivePlanPath: "/tmp/docs/development/plans/p.md",
			planPathInWorktreeExists: true,
		},
		originFor: originForImpl,
		redactedRecorder: () => recorder,
	};
}

describe("Phase 1 writer-shape freeze", () => {
	test("Slice 06 can consume RecordCommandContext.originFor and PreparedRecordStep.performer", () => {
		const performer: RecordPerformer = {
			kind: "agent",
			role: "reviewer",
			provider: "opencode",
		};
		const recorder: RecordRecorder = {
			installation_id: INSTALLATION_ID,
			actor: "test-operator",
		};
		const ctx = fixtureWriterContext(originFor, recorder);
		const prepared: PreparedRecordStep = {
			runId: "run_1",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			resultJson: "{}",
			headCommit: "abc123",
			effectiveWorkdir: "/tmp",
			maxSteps: 50,
			performer,
		};
		const admit: PrepareRecordStepOutcome = { outcome: "admit", prepared };
		const envelopes = stampPairedOps(ctx, admit.prepared);
		expect(envelopes).toHaveLength(2);
		expect(envelopes[0]).toEqual(envelopes[1]);
		expect(envelopes[0]?.origin?.performer).toEqual(performer);
		expect(ctx.redactedRecorder()).toEqual(recorder);

		const publicCtx: PublicRecordCommandContext = ctx;
		const publicPrepared: PublicPreparedRecordStep = prepared;
		const publicOutcome: PublicPrepareRecordStepOutcome = admit;
		expect(publicCtx.originFor(publicPrepared.performer).performer).toEqual(
			performer,
		);
		expect(publicOutcome.prepared.performer).toEqual(performer);
	});

	test("public barrels re-export the writer-shape types", () => {
		const controlPlaneIndex = readFileSync(
			join(import.meta.dir, "../../../src/control-plane/index.ts"),
			"utf8",
		);
		const publicIndex = readFileSync(
			join(import.meta.dir, "../../../src/index.ts"),
			"utf8",
		);
		for (const text of [controlPlaneIndex, publicIndex]) {
			expect(text.includes("RecordCommandContext")).toBe(true);
			expect(text.includes("PreparedRecordStep")).toBe(true);
			expect(text.includes("PrepareRecordStepOutcome")).toBe(true);
		}
	});
});
