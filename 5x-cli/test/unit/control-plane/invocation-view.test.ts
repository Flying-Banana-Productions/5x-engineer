/**
 * Unit tests for invocation client-state derivation and JSON envelopes.
 */

import { describe, expect, test } from "bun:test";
import type { InvocationRecord } from "../../../src/control-plane/invocation-types.js";
import {
	toClientInvocationState,
	toClientInvocationView,
	toInvocationStatusEnvelope,
} from "../../../src/control-plane/invocation-view.js";

function record(overrides: Partial<InvocationRecord> = {}): InvocationRecord {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		runId: "run_abc123def456",
		sessionId: "sess-1",
		role: "author",
		providerName: "sample",
		templateName: "author.md",
		handle: { adapter: "none", ref: "sess-1" },
		cancellationSupported: true,
		status: "running",
		createdAt: "2026-08-28 00:00:00",
		updatedAt: "2026-08-28 00:00:00",
		cancellationRequestedAt: null,
		cancellationRequestedBy: null,
		cancellationOutcome: null,
		cancellationOutcomeAt: null,
		terminalAt: null,
		abandonReason: null,
		...overrides,
	};
}

describe("toClientInvocationState", () => {
	test("abandoned status maps to abandoned", () => {
		expect(
			toClientInvocationState(
				record({
					status: "abandoned",
					terminalAt: "2026-08-28 00:01:00",
					abandonReason: "stale-metadata",
				}),
			),
		).toBe("abandoned");
	});

	test("cancelled status maps to cancelled", () => {
		expect(
			toClientInvocationState(
				record({
					status: "cancelled",
					terminalAt: "2026-08-28 00:01:00",
				}),
			),
		).toBe("cancelled");
	});

	test("completed status maps to completed", () => {
		expect(
			toClientInvocationState(
				record({
					status: "completed",
					terminalAt: "2026-08-28 00:01:00",
				}),
			),
		).toBe("completed");
	});

	test("failed status maps to failed", () => {
		expect(
			toClientInvocationState(
				record({
					status: "failed",
					terminalAt: "2026-08-28 00:01:00",
				}),
			),
		).toBe("failed");
	});

	test("running + supported maps to running", () => {
		expect(
			toClientInvocationState(record({ cancellationSupported: true })),
		).toBe("running");
	});

	test("running + unsupported maps to unsupported", () => {
		expect(
			toClientInvocationState(record({ cancellationSupported: false })),
		).toBe("unsupported");
	});

	test("running + requested maps to cancellation-requested", () => {
		expect(
			toClientInvocationState(
				record({
					cancellationSupported: true,
					cancellationRequestedAt: "2026-08-28 00:00:30",
					cancellationRequestedBy: "cli",
				}),
			),
		).toBe("cancellation-requested");
	});

	test("requested takes precedence over unsupported", () => {
		expect(
			toClientInvocationState(
				record({
					cancellationSupported: false,
					cancellationRequestedAt: "2026-08-28 00:00:30",
					cancellationRequestedBy: "cli",
				}),
			),
		).toBe("cancellation-requested");
	});
});

describe("toClientInvocationView", () => {
	test("omits handle and pid", () => {
		const view = toClientInvocationView(record());
		expect(view).not.toHaveProperty("handle");
		expect(view).not.toHaveProperty("pid");
		const encoded = JSON.stringify(view);
		expect(encoded).not.toContain('"handle"');
		expect(encoded).not.toContain('"pid"');
	});

	test("maps cancellation fields and none outcome", () => {
		const view = toClientInvocationView(record());
		expect(view.clientState).toBe("running");
		expect(view.cancellation).toEqual({
			supported: true,
			requested: false,
			requestedBy: null,
			outcome: "none",
		});
	});
});

describe("toInvocationStatusEnvelope", () => {
	test("maps camelCase view keys to snake_case JSON keys", () => {
		const view = toClientInvocationView(
			record({
				cancellationRequestedAt: "2026-08-28 00:00:30",
				cancellationRequestedBy: "control-plane",
				cancellationOutcome: "succeeded",
				cancellationOutcomeAt: "2026-08-28 00:00:31",
			}),
		);
		const envelope = toInvocationStatusEnvelope(view);
		expect(envelope.client_state).toBe("cancellation-requested");
		expect(envelope.run_id).toBe("run_abc123def456");
		expect(envelope.session_id).toBe("sess-1");
		expect(envelope.provider_name).toBe("sample");
		expect(envelope.template_name).toBe("author.md");
		expect(envelope.created_at).toBe("2026-08-28 00:00:00");
		expect(envelope.updated_at).toBe("2026-08-28 00:00:00");
		expect(envelope.terminal_at).toBeNull();
		expect(envelope.cancellation.requested_by).toBe("control-plane");
		expect(envelope.cancellation.outcome).toBe("succeeded");
		expect(envelope).not.toHaveProperty("clientState");
		expect(envelope).not.toHaveProperty("runId");
		expect(envelope).not.toHaveProperty("handle");
		expect(envelope).not.toHaveProperty("pid");
		const encoded = JSON.stringify(envelope);
		expect(encoded).toContain('"client_state"');
		expect(encoded).not.toContain('"clientState"');
		expect(encoded).not.toContain('"handle"');
		expect(encoded).not.toContain('"pid"');
	});
});
