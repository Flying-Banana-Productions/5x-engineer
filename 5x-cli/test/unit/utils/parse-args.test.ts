import { describe, expect, test } from "bun:test";
import { CliError } from "../../../src/output.js";
import {
	parseFloatArg,
	parseIntArg,
	parseTimeout,
} from "../../../src/utils/parse-args.js";

describe("parseIntArg", () => {
	test("parses valid integer", () => {
		expect(parseIntArg("42", "--count")).toBe(42);
	});

	test("parses zero", () => {
		expect(parseIntArg("0", "--count")).toBe(0);
	});

	test("rejects non-integer string", () => {
		expect(() => parseIntArg("abc", "--count")).toThrow(CliError);
	});

	test("rejects trailing junk", () => {
		expect(() => parseIntArg("1abc", "--count")).toThrow(CliError);
	});

	test("rejects float string", () => {
		expect(() => parseIntArg("1.5", "--count")).toThrow(CliError);
	});

	test("rejects empty string", () => {
		expect(() => parseIntArg("", "--count")).toThrow(CliError);
	});

	test("rejects negative when no opts", () => {
		expect(() => parseIntArg("-1", "--count")).toThrow(CliError);
	});

	test("rejects zero with positive option", () => {
		expect(() => parseIntArg("0", "--count", { positive: true })).toThrow(
			CliError,
		);
	});

	test("rejects negative with positive option", () => {
		expect(() => parseIntArg("-1", "--count", { positive: true })).toThrow(
			CliError,
		);
	});

	test("accepts positive integer with positive option", () => {
		expect(parseIntArg("5", "--count", { positive: true })).toBe(5);
	});

	test("error includes flag name in message", () => {
		try {
			parseIntArg("bad", "--my-flag");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(CliError);
			expect((e as CliError).message).toContain("--my-flag");
		}
	});

	test("error code is INVALID_ARGS", () => {
		try {
			parseIntArg("bad", "--flag");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as CliError).code).toBe("INVALID_ARGS");
		}
	});
});

describe("parseFloatArg", () => {
	test("parses valid float", () => {
		expect(parseFloatArg("3.14", "--cost")).toBeCloseTo(3.14);
	});

	test("parses integer as float", () => {
		expect(parseFloatArg("42", "--cost")).toBe(42);
	});

	test("parses zero", () => {
		expect(parseFloatArg("0", "--cost")).toBe(0);
	});

	test("parses zero point zero", () => {
		expect(parseFloatArg("0.0", "--cost")).toBe(0);
	});

	test("rejects non-numeric string", () => {
		expect(() => parseFloatArg("abc", "--cost")).toThrow(CliError);
	});

	test("rejects trailing junk", () => {
		expect(() => parseFloatArg("1.5abc", "--cost")).toThrow(CliError);
	});

	test("rejects empty string", () => {
		expect(() => parseFloatArg("", "--cost")).toThrow(CliError);
	});

	test("allows negative by default", () => {
		expect(parseFloatArg("-1.5", "--cost")).toBeCloseTo(-1.5);
	});

	test("rejects negative with nonNegative option", () => {
		expect(() =>
			parseFloatArg("-0.01", "--cost", { nonNegative: true }),
		).toThrow(CliError);
	});

	test("accepts zero with nonNegative option", () => {
		expect(parseFloatArg("0", "--cost", { nonNegative: true })).toBe(0);
	});

	test("error includes flag name in message", () => {
		try {
			parseFloatArg("bad", "--my-cost");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(CliError);
			expect((e as CliError).message).toContain("--my-cost");
		}
	});

	test("error code is INVALID_ARGS", () => {
		try {
			parseFloatArg("bad", "--flag");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as CliError).code).toBe("INVALID_ARGS");
		}
	});
});

describe("parseTimeout", () => {
	test("returns undefined for undefined", () => {
		expect(parseTimeout(undefined)).toBeUndefined();
	});

	test("returns undefined for empty string", () => {
		expect(parseTimeout("")).toBeUndefined();
	});

	test("parses valid positive integer string", () => {
		expect(parseTimeout("30")).toBe(30);
	});

	test("parses numeric input", () => {
		expect(parseTimeout(60)).toBe(60);
	});

	test("rejects zero", () => {
		expect(() => parseTimeout("0")).toThrow(CliError);
	});

	test("rejects negative", () => {
		expect(() => parseTimeout("-5")).toThrow(CliError);
	});

	test("rejects non-numeric string", () => {
		expect(() => parseTimeout("abc")).toThrow(CliError);
	});

	test("rejects partial numeric string", () => {
		expect(() => parseTimeout("10abc")).toThrow(CliError);
	});

	test("rejects float string", () => {
		expect(() => parseTimeout("1.5")).toThrow(CliError);
	});

	test("rejects leading-zero forms like '05'", () => {
		// String(parseInt("05")) === "5" !== "05", so strict equality rejects it
		expect(() => parseTimeout("05")).toThrow(CliError);
	});
});
