import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	FORBIDDEN_ORIGIN_KEYS,
	redactOrigin,
	redactRecorder,
	redactStepPayload,
} from "../../../src/control-plane/record-redact.js";
import type {
	RecordOrigin,
	RecordRecorder,
	StepRecordPayload,
} from "../../../src/control-plane/record-types.js";

const INSTALLATION_ID = randomUUID();

function payload(
	overrides: Partial<StepRecordPayload> = {},
): StepRecordPayload {
	return {
		step_name: "git:commit",
		phase: "1",
		iteration: 1,
		result_json: { sha: "aaa" },
		head_commit: "abc123",
		patch_id: null,
		diff_summary: null,
		duration_ms: 10,
		tokens_in: 1,
		tokens_out: 2,
		cost_usd: 0.5,
		model: "gpt",
		...overrides,
	};
}

describe("redactStepPayload", () => {
	test("drops cost_usd to null; ignores unknown names; refuses to strip result_json", () => {
		const redacted = redactStepPayload(payload(), [
			"cost_usd",
			"not_a_field",
			"result_json",
			"step_name",
			"phase",
			"iteration",
			"head_commit",
		]);
		expect(redacted.cost_usd).toBeNull();
		expect(redacted.result_json).toEqual({ sha: "aaa" });
		expect(redacted.step_name).toBe("git:commit");
		expect(redacted.phase).toBe("1");
		expect(redacted.iteration).toBe(1);
		expect(redacted.head_commit).toBe("abc123");
		expect(redacted.model).toBe("gpt");
	});

	test("always omits smuggled session_id and log_path", () => {
		const widened = {
			...payload(),
			session_id: "sess-1",
			log_path: "/tmp/log",
		} as StepRecordPayload;
		const redacted = redactStepPayload(widened, []);
		expect(redacted).not.toHaveProperty("session_id");
		expect(redacted).not.toHaveProperty("log_path");
	});
});

describe("redactOrigin / redactRecorder", () => {
	const origin: RecordOrigin = {
		recorder: { installation_id: INSTALLATION_ID, actor: "spalmer" },
		performer: { kind: "agent", role: "author", provider: "cursor" },
	};

	test("origin.actor redacted; installation_id and performer.kind remain", () => {
		const redacted = redactOrigin(origin, ["origin.actor"]);
		expect(redacted?.recorder.actor).toBeUndefined();
		expect(redacted?.recorder.installation_id).toBe(INSTALLATION_ID);
		expect(redacted?.performer.kind).toBe("agent");
		expect(redactOrigin(origin, ["actor"])?.recorder.actor).toBeUndefined();
	});

	test("hostname smuggled on origin is deleted", () => {
		const widened = {
			...origin,
			hostname: "box",
			recorder: {
				...origin.recorder,
				username: "os-user",
				session_id: "s",
			},
			performer: { ...origin.performer, hardware_id: "hw" },
		} as RecordOrigin;
		const redacted = redactOrigin(widened, []);
		expect(redacted).not.toHaveProperty("hostname");
		expect(redacted?.recorder).not.toHaveProperty("username");
		expect(redacted?.recorder).not.toHaveProperty("session_id");
		expect(redacted?.performer).not.toHaveProperty("hardware_id");
		expect(redacted?.recorder.installation_id).toBe(INSTALLATION_ID);
	});

	test("null origin stays null", () => {
		expect(redactOrigin(null, ["origin.actor"])).toBeNull();
	});

	test("redactRecorder omits actor and strips forbidden keys without touching installation_id", () => {
		const recorder: RecordRecorder = {
			installation_id: INSTALLATION_ID,
			actor: "spalmer",
		};
		const widened = {
			...recorder,
			hostname: "box",
			os_username: "os",
		} as RecordRecorder;
		const redacted = redactRecorder(widened, ["origin.actor"]);
		expect(redacted.actor).toBeUndefined();
		expect(redacted.installation_id).toBe(INSTALLATION_ID);
		expect(redacted).not.toHaveProperty("hostname");
		expect(redacted).not.toHaveProperty("os_username");
		for (const key of FORBIDDEN_ORIGIN_KEYS) {
			expect(redacted).not.toHaveProperty(key);
		}
	});
});
