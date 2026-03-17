/**
 * Unit tests for protocol emit handler.
 *
 * Tests the handler functions directly by capturing stdout writes.
 * Error cases are tested by catching CliError thrown by outputError().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	protocolEmitAuthor,
	protocolEmitReviewer,
} from "../../../src/commands/protocol-emit.handler.js";
import { CliError } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// stdout capture
// ---------------------------------------------------------------------------

let stdoutData: string;
const originalWrite = process.stdout.write;

beforeEach(() => {
	stdoutData = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutData +=
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
});

function parseOutput(): Record<string, unknown> {
	return JSON.parse(stdoutData) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reviewer emit
// ---------------------------------------------------------------------------

describe("protocolEmitReviewer", () => {
	test("--ready with no items → ready", async () => {
		await protocolEmitReviewer({ ready: true });
		const result = parseOutput();
		expect(result.readiness).toBe("ready");
		expect(result.items).toEqual([]);
	});

	test("--ready with items → ready_with_corrections", async () => {
		await protocolEmitReviewer({
			ready: true,
			item: ['{"title":"Fix X","action":"auto_fix","reason":"Broken"}'],
		});
		const result = parseOutput();
		expect(result.readiness).toBe("ready_with_corrections");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("Fix X");
	});

	test("--no-ready with items → not_ready", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: ['{"title":"Fix X","action":"auto_fix","reason":"Broken"}'],
		});
		const result = parseOutput();
		expect(result.readiness).toBe("not_ready");
		expect((result.items as unknown[]).length).toBe(1);
	});

	test("--no-ready without items → not_ready with empty items", async () => {
		await protocolEmitReviewer({ ready: false });
		const result = parseOutput();
		expect(result.readiness).toBe("not_ready");
		expect(result.items).toEqual([]);
	});

	test("auto-generates item ids when missing", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: [
				'{"title":"A","action":"auto_fix","reason":"X"}',
				'{"title":"B","action":"auto_fix","reason":"Y"}',
			],
		});
		const result = parseOutput();
		const items = result.items as Array<Record<string, unknown>>;
		// Items already have ids from the handler (R1, R2), and normalization
		// preserves existing ids
		expect(items[0]?.id).toBe("R1");
		expect(items[1]?.id).toBe("R2");
	});

	test("defaults item action to human_required when missing", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: ['{"title":"X","reason":"Y"}'],
		});
		const result = parseOutput();
		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.action).toBe("human_required");
	});

	test("--summary included in output", async () => {
		await protocolEmitReviewer({ ready: true, summary: "Looks good" });
		const result = parseOutput();
		expect(result.summary).toBe("Looks good");
	});

	test("missing --ready/--no-ready without stdin → error", async () => {
		// ready=undefined and no stdin (isTTY will vary, but stdinData not provided)
		try {
			await protocolEmitReviewer({ ready: undefined, stdinData: undefined });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
		}
	});

	test("stdin fallback normalizes and emits", async () => {
		await protocolEmitReviewer({
			ready: undefined,
			stdinData: JSON.stringify({
				verdict: "approved",
				items: [],
			}),
		});
		const result = parseOutput();
		expect(result.readiness).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// Author emit
// ---------------------------------------------------------------------------

describe("protocolEmitAuthor", () => {
	test("--complete --commit → complete", async () => {
		await protocolEmitAuthor({ complete: true, commit: "abc123" });
		const result = parseOutput();
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
	});

	test("--needs-human --reason → needs_human", async () => {
		await protocolEmitAuthor({
			needsHuman: true,
			reason: "Need design decision",
		});
		const result = parseOutput();
		expect(result.result).toBe("needs_human");
		expect(result.reason).toBe("Need design decision");
	});

	test("--failed --reason → failed", async () => {
		await protocolEmitAuthor({
			failed: true,
			reason: "Tests broken beyond repair",
		});
		const result = parseOutput();
		expect(result.result).toBe("failed");
		expect(result.reason).toBe("Tests broken beyond repair");
	});

	test("--complete without --commit → error", async () => {
		try {
			await protocolEmitAuthor({ complete: true });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
			expect((err as CliError).message).toContain("--commit");
		}
	});

	test("--needs-human without --reason → error", async () => {
		try {
			await protocolEmitAuthor({ needsHuman: true });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
			expect((err as CliError).message).toContain("--reason");
		}
	});

	test("multiple result flags → error", async () => {
		try {
			await protocolEmitAuthor({
				complete: true,
				needsHuman: true,
				commit: "abc",
			});
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
		}
	});

	test("--notes included in output", async () => {
		await protocolEmitAuthor({
			complete: true,
			commit: "abc123",
			notes: "All done",
		});
		const result = parseOutput();
		expect(result.notes).toBe("All done");
	});

	test("stdin fallback normalizes legacy status", async () => {
		await protocolEmitAuthor({
			stdinData: JSON.stringify({
				status: "done",
				commit: "abc123",
			}),
		});
		const result = parseOutput();
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
	});
});
