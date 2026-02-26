import { describe, expect, test } from "bun:test";
import { resolveAnsi } from "../../src/utils/ansi.js";

describe("resolveAnsi", () => {
	test("NO_COLOR set → colorEnabled false, dim/reset empty", () => {
		const result = resolveAnsi({ isTTY: true, env: { NO_COLOR: "1" } });
		expect(result.colorEnabled).toBe(false);
		expect(result.dim).toBe("");
		expect(result.reset).toBe("");
	});

	test("NO_COLOR set + FORCE_COLOR set → NO_COLOR wins", () => {
		const result = resolveAnsi({
			isTTY: true,
			env: { NO_COLOR: "", FORCE_COLOR: "1" },
		});
		expect(result.colorEnabled).toBe(false);
		expect(result.dim).toBe("");
		expect(result.reset).toBe("");
	});

	test("FORCE_COLOR=1 → colorEnabled true", () => {
		const result = resolveAnsi({
			isTTY: false,
			env: { FORCE_COLOR: "1" },
		});
		expect(result.colorEnabled).toBe(true);
		expect(result.dim).toBe("\x1b[2m");
		expect(result.reset).toBe("\x1b[0m");
	});

	test("FORCE_COLOR=0 → colorEnabled false", () => {
		const result = resolveAnsi({
			isTTY: true,
			env: { FORCE_COLOR: "0" },
		});
		expect(result.colorEnabled).toBe(false);
		expect(result.dim).toBe("");
		expect(result.reset).toBe("");
	});

	test("no env vars, isTTY=true → colorEnabled true", () => {
		const result = resolveAnsi({ isTTY: true, env: {} });
		expect(result.colorEnabled).toBe(true);
		expect(result.dim).toBe("\x1b[2m");
		expect(result.reset).toBe("\x1b[0m");
	});

	test("no env vars, isTTY=false → colorEnabled false", () => {
		const result = resolveAnsi({ isTTY: false, env: {} });
		expect(result.colorEnabled).toBe(false);
		expect(result.dim).toBe("");
		expect(result.reset).toBe("");
	});

	test("default parameters (no args) → does not throw", () => {
		expect(() => resolveAnsi()).not.toThrow();
		const result = resolveAnsi();
		expect(typeof result.colorEnabled).toBe("boolean");
		expect(typeof result.dim).toBe("string");
		expect(typeof result.reset).toBe("string");
	});
});
