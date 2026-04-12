import { describe, expect, test } from "bun:test";
import {
	formatPromptOverLimitMessage,
	getPromptBytes,
	guardPromptSize,
	MAX_PROMPT_BYTES,
} from "../../../../packages/provider-claude-code/src/prompt-guard.js";

describe("getPromptBytes", () => {
	test("ASCII counts bytes not chars", () => {
		expect(getPromptBytes("abc")).toBe(3);
	});

	test("Unicode uses UTF-8 byte length", () => {
		expect(getPromptBytes("é")).toBe(2);
		expect(getPromptBytes("你好")).toBe(6);
	});
});

describe("guardPromptSize", () => {
	test("ASCII boundary limit-1 ok", () => {
		const limit = 100;
		const s = "a".repeat(limit - 1);
		const r = guardPromptSize(s, limit);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.bytes).toBe(limit - 1);
	});

	test("ASCII boundary at limit ok", () => {
		const limit = 100;
		const s = "a".repeat(limit);
		const r = guardPromptSize(s, limit);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.bytes).toBe(limit);
	});

	test("ASCII boundary limit+1 fails", () => {
		const limit = 100;
		const s = "a".repeat(limit + 1);
		const r = guardPromptSize(s, limit);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.actualBytes).toBe(limit + 1);
			expect(r.error.maxBytes).toBe(limit);
		}
	});

	test("Unicode boundary uses bytes not code units", () => {
		const limit = 5;
		// "é" = 2 bytes each; 2+2+2 = 6 > 5
		const s = "ééé";
		const r = guardPromptSize(s, limit);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.actualBytes).toBe(6);
	});

	test("message shape is stable", () => {
		const r = guardPromptSize("x".repeat(10), 5);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			const msg = formatPromptOverLimitMessage(r.error);
			expect(msg).toContain("10");
			expect(msg).toContain("5");
			expect(msg).toContain("bytes");
		}
	});

	test("default max is MAX_PROMPT_BYTES", () => {
		expect(guardPromptSize("").ok).toBe(true);
		const atLimit = "a".repeat(MAX_PROMPT_BYTES);
		expect(guardPromptSize(atLimit).ok).toBe(true);
		expect(guardPromptSize(`${atLimit}a`).ok).toBe(false);
	});
});
