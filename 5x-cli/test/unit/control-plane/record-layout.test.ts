import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	decodeJsonlFile,
	encodeJsonlLine,
	encodeRunJson,
	parseRunJson,
} from "../../../src/control-plane/record-layout.js";
import {
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	type RecordOrigin,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/record-types.js";

const INSTALLATION_ID = randomUUID();
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: INSTALLATION_ID, actor: "spalmer" },
	performer: { kind: "agent", role: "author", provider: "cursor" },
};
const EXPORTER: RecordOrigin = {
	recorder: { installation_id: INSTALLATION_ID },
	performer: { kind: "system", role: "exporter" },
};

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`expected RecordStoreError ${code}`);
	} catch (err) {
		expect(err).toBeInstanceOf(RecordStoreError);
		expect((err as RecordStoreError).code).toBe(code);
	}
}

function stepLine(overrides: Partial<RecordLine> = {}): RecordLine {
	return {
		runId: "run_ab",
		stream: "steps",
		idempotencyKey: "step:run_ab:author:impl:1:1",
		payload: { step_name: "author:impl", ok: true },
		createdAt: "2026-08-31 12:00:00",
		schemaVersion: RECORD_LINE_SCHEMA_VERSION,
		provenance: "recorded",
		origin: ORIGIN,
		...overrides,
	};
}

function envelope(stream: RecordLine["stream"], key: string, origin = ORIGIN) {
	return {
		schema_version: 1,
		stream,
		idempotency_key: key,
		created_at: "2026-08-31 12:00:00",
		provenance: "recorded",
		origin,
		payload: { n: 1 },
	};
}

describe("encodeJsonlLine / decodeJsonlFile", () => {
	test("steps, decisions, and budget reconstruct runId and round-trip origin", () => {
		for (const stream of ["steps", "decisions", "budget"] as const) {
			const line = stepLine({
				stream,
				idempotencyKey: `${stream}:k`,
				runId: "run_caller",
			});
			const encoded = encodeJsonlLine(line);
			expect(JSON.parse(encoded)).not.toHaveProperty("run_id");
			expect(encoded).not.toMatch(/"run_id"/);
			const decoded = decodeJsonlFile(`${encoded}\n`, "run_caller");
			expect(decoded).toHaveLength(1);
			expect(decoded[0]?.runId).toBe("run_caller");
			expect(decoded[0]?.stream).toBe(stream);
			expect(decoded[0]?.origin).toEqual(ORIGIN);
			expect(decoded[0]?.provenance).toBe("recorded");
			expect(decoded[0]?.schemaVersion).toBe(RECORD_LINE_SCHEMA_VERSION);
		}
	});

	test("mismatched on-disk run_id throws INVALID_JSONL", () => {
		const obj = { ...envelope("steps", "k"), run_id: "other" };
		expectCode(
			() => decodeJsonlFile(`${JSON.stringify(obj)}\n`, "run_ab"),
			"INVALID_JSONL",
		);
	});

	test("matching on-disk run_id is accepted and caller runId is used", () => {
		const obj = { ...envelope("budget", "k"), run_id: "run_ab" };
		const decoded = decodeJsonlFile(`${JSON.stringify(obj)}\n`, "run_ab");
		expect(decoded[0]?.runId).toBe("run_ab");
	});

	test("conflict-marker lines throw INVALID_JSONL", () => {
		const good = JSON.stringify(envelope("steps", "k"));
		expectCode(
			() => decodeJsonlFile(`<<<<<<< HEAD\n${good}\n`, "run_ab"),
			"INVALID_JSONL",
		);
		expectCode(
			() => decodeJsonlFile(`${good}\n=======\n`, "run_ab"),
			"INVALID_JSONL",
		);
		expectCode(
			() => decodeJsonlFile(`>>>>>>> branch\n`, "run_ab"),
			"INVALID_JSONL",
		);
	});

	test("first idempotency_key wins including origin", () => {
		const first = {
			...envelope("steps", "dup"),
			origin: ORIGIN,
			payload: { first: true },
		};
		const secondOrigin: RecordOrigin = {
			recorder: { installation_id: randomUUID(), actor: "other" },
			performer: { kind: "human", role: "operator" },
		};
		const second = {
			...envelope("steps", "dup"),
			origin: secondOrigin,
			payload: { first: false },
		};
		const decoded = decodeJsonlFile(
			`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
			"run_ab",
		);
		expect(decoded).toHaveLength(1);
		expect(decoded[0]?.payload).toEqual({ first: true });
		expect(decoded[0]?.origin).toEqual(ORIGIN);
	});

	test("blank lines are skipped", () => {
		const obj = envelope("decisions", "d1");
		const decoded = decodeJsonlFile(`\n${JSON.stringify(obj)}\n\n`, "run_ab");
		expect(decoded).toHaveLength(1);
	});

	test("missing schema_version, schema_version 0, recorded+null origin, recorded+materializer, unknown performer.kind throw", () => {
		const base = envelope("steps", "k");
		const { schema_version: _, ...noVersion } = base;
		expectCode(
			() => decodeJsonlFile(`${JSON.stringify(noVersion)}\n`, "run_ab"),
			"INVALID_JSONL",
		);
		expectCode(
			() =>
				decodeJsonlFile(
					`${JSON.stringify({ ...base, schema_version: 0 })}\n`,
					"run_ab",
				),
			"INVALID_JSONL",
		);
		expectCode(
			() =>
				decodeJsonlFile(
					`${JSON.stringify({ ...base, origin: null })}\n`,
					"run_ab",
				),
			"INVALID_JSONL",
		);
		expectCode(
			() =>
				decodeJsonlFile(
					`${JSON.stringify({ ...base, materializer: EXPORTER })}\n`,
					"run_ab",
				),
			"INVALID_JSONL",
		);
		expectCode(
			() =>
				decodeJsonlFile(
					`${JSON.stringify({
						...base,
						origin: {
							recorder: { installation_id: INSTALLATION_ID },
							performer: { kind: "robot" },
						},
					})}\n`,
					"run_ab",
				),
			"INVALID_JSONL",
		);
	});

	test("schema_version 2 with all v1 fields succeeds and ignores future_field", () => {
		const obj = {
			...envelope("budget", "b1"),
			schema_version: 2,
			future_field: true,
		};
		const decoded = decodeJsonlFile(`${JSON.stringify(obj)}\n`, "run_ab");
		expect(decoded[0]?.schemaVersion).toBe(2);
		expect(decoded[0]?.origin).toEqual(ORIGIN);
		expect(decoded[0]).not.toHaveProperty("future_field");
	});

	test("schema_version 2 missing a v1 field throws INVALID_JSONL", () => {
		const { payload: _p, ...missing } = {
			...envelope("steps", "k"),
			schema_version: 2,
		};
		expectCode(
			() => decodeJsonlFile(`${JSON.stringify(missing)}\n`, "run_ab"),
			"INVALID_JSONL",
		);
	});

	test("backfilled line with origin null and materializer decodes", () => {
		const obj = {
			schema_version: 1,
			stream: "steps",
			idempotency_key: "step:run_ab:backfill::1",
			created_at: "2026-08-31 12:00:00",
			provenance: "backfilled",
			origin: null,
			materializer: EXPORTER,
			payload: { step_name: "backfill" },
		};
		const decoded = decodeJsonlFile(`${JSON.stringify(obj)}\n`, "run_ab");
		expect(decoded[0]?.origin).toBeNull();
		expect(decoded[0]?.materializer).toEqual(EXPORTER);
		expect(decoded[0]?.provenance).toBe("backfilled");
	});

	test("encode strips forbidden origin keys from a widened object", () => {
		const widened = {
			...ORIGIN,
			hostname: "secret-host",
			recorder: {
				...ORIGIN.recorder,
				username: "os-user",
				session_id: "sess",
			},
		} as RecordOrigin;
		const encoded = encodeJsonlLine(stepLine({ origin: widened }));
		const parsed = JSON.parse(encoded) as Record<string, unknown>;
		const origin = parsed.origin as Record<string, unknown>;
		expect(origin).not.toHaveProperty("hostname");
		const recorder = origin.recorder as Record<string, unknown>;
		expect(recorder).not.toHaveProperty("username");
		expect(recorder).not.toHaveProperty("session_id");
		expect(recorder.installation_id).toBe(INSTALLATION_ID);
	});
});

describe("parseRunJson / encodeRunJson", () => {
	test("creator null and omitted sealer round-trip", () => {
		const summary = parseRunJson(
			JSON.stringify({
				id: "run_ab",
				plan_path: "docs/development/plans/foo.md",
				config_json: null,
				created_at: "2026-08-31 12:00:00",
				sealed_at: null,
				status: "active",
				final_head_commit: null,
				cli_version: "1.3.0",
				format_version: 1,
				creator: null,
				backfilled: true,
				materializer: EXPORTER,
			}),
		);
		expect(summary.creator).toBeNull();
		expect(summary.sealer).toBeUndefined();
		expect(summary.materializer).toEqual(EXPORTER);
		const round = parseRunJson(encodeRunJson(summary));
		expect(round.creator).toBeNull();
		expect(round.sealer).toBeUndefined();
		expect(round.materializer).toEqual(EXPORTER);
	});

	test("terminal summary with null creator/sealer and materializer round-trips", () => {
		const summary = parseRunJson(
			JSON.stringify({
				id: "run_ab",
				plan_path: "docs/development/plans/foo.md",
				created_at: "2026-08-31 12:00:00",
				sealed_at: "2026-08-31 13:00:00",
				status: "completed",
				format_version: 1,
				creator: null,
				sealer: null,
				materializer: EXPORTER,
				final_head_commit: "abc",
				cli_version: "1.3.0",
				config_json: null,
			}),
		);
		expect(summary.creator).toBeNull();
		expect(summary.sealer).toBeNull();
		expect(summary.materializer).toEqual(EXPORTER);
		const round = parseRunJson(encodeRunJson(summary));
		expect(round.creator).toBeNull();
		expect(round.sealer).toBeNull();
		expect(round.materializer).toEqual(EXPORTER);
		expect(round.materializer).not.toBe(round.creator);
	});

	test("format_version 2 with future_field succeeds; typed object drops future_field", () => {
		const summary = parseRunJson(
			JSON.stringify({
				id: "run_ab",
				plan_path: "docs/development/plans/foo.md",
				created_at: "2026-08-31 12:00:00",
				sealed_at: null,
				status: "active",
				format_version: 2,
				creator: { installation_id: INSTALLATION_ID },
				final_head_commit: null,
				cli_version: "1.3.0",
				config_json: null,
				future_field: true,
			}),
		);
		expect(summary.format_version).toBe(2);
		expect(summary).not.toHaveProperty("future_field");
		expect(summary.creator?.installation_id).toBe(INSTALLATION_ID);
	});

	test("missing format_version is INVALID_JSONL", () => {
		expectCode(
			() =>
				parseRunJson(
					JSON.stringify({
						id: "run_ab",
						plan_path: "docs/development/plans/foo.md",
						created_at: "2026-08-31 12:00:00",
						sealed_at: null,
						status: "active",
						creator: null,
					}),
				),
			"INVALID_JSONL",
		);
	});

	test("writers emit format_version 1", () => {
		const text = encodeRunJson({
			id: "run_ab",
			plan_path: "docs/development/plans/foo.md",
			config_json: null,
			created_at: "2026-08-31 12:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "1.3.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: { installation_id: INSTALLATION_ID },
		});
		expect(JSON.parse(text).format_version).toBe(1);
	});
});
