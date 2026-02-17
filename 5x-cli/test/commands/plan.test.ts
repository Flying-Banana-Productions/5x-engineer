import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	computePlanPath,
	nextSequenceNumber,
	slugFromPath,
} from "../../src/commands/plan.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-plan-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true });
});

describe("slugFromPath", () => {
	test("strips leading sequence number and extension", () => {
		expect(slugFromPath("370-court-time-allocation-reporting.md")).toBe(
			"court-time-allocation-reporting",
		);
	});

	test("handles filename without sequence number", () => {
		expect(slugFromPath("some-feature-spec.md")).toBe("some-feature-spec");
	});

	test("lowercases and replaces non-alphanumeric chars", () => {
		expect(slugFromPath("My Cool Feature (v2).md")).toBe("my-cool-feature-v2");
	});

	test("collapses consecutive hyphens", () => {
		expect(slugFromPath("foo---bar--baz.md")).toBe("foo-bar-baz");
	});

	test("trims leading/trailing hyphens", () => {
		expect(slugFromPath("-leading-trailing-.md")).toBe("leading-trailing");
	});

	test("handles deeply nested path", () => {
		expect(slugFromPath("docs/workflows/370-some-feature.md")).toBe(
			"some-feature",
		);
	});
});

describe("nextSequenceNumber", () => {
	test("returns 001 for empty directory", () => {
		expect(nextSequenceNumber(tmp)).toBe("001");
	});

	test("returns 001 for non-existent directory", () => {
		expect(nextSequenceNumber(join(tmp, "nonexistent"))).toBe("001");
	});

	test("increments from existing plan files", () => {
		writeFileSync(join(tmp, "001-impl-foo.md"), "");
		writeFileSync(join(tmp, "002-impl-bar.md"), "");
		expect(nextSequenceNumber(tmp)).toBe("003");
	});

	test("ignores non-matching files", () => {
		writeFileSync(join(tmp, "001-impl-foo.md"), "");
		writeFileSync(join(tmp, "README.md"), "");
		writeFileSync(join(tmp, "some-other-file.txt"), "");
		expect(nextSequenceNumber(tmp)).toBe("002");
	});

	test("handles gaps in sequence numbers", () => {
		writeFileSync(join(tmp, "001-impl-foo.md"), "");
		writeFileSync(join(tmp, "005-impl-bar.md"), "");
		expect(nextSequenceNumber(tmp)).toBe("006");
	});
});

describe("computePlanPath", () => {
	test("generates path with next sequence number and slug", () => {
		const result = computePlanPath(tmp, "370-court-time-allocation.md");
		expect(result).toBe(join(tmp, "001-impl-court-time-allocation.md"));
	});

	test("increments when existing plan files are present", () => {
		writeFileSync(join(tmp, "001-impl-foo.md"), "");
		const result = computePlanPath(tmp, "some-feature.md");
		expect(result).toBe(join(tmp, "002-impl-some-feature.md"));
	});

	test("auto-increments on collision", () => {
		// Pre-create the file that would naturally be computed
		writeFileSync(join(tmp, "001-impl-foo.md"), "");
		writeFileSync(join(tmp, "002-impl-foo.md"), "");
		const result = computePlanPath(tmp, "foo.md");
		expect(result).toBe(join(tmp, "003-impl-foo.md"));
	});

	test("creates path for non-existent plans directory", () => {
		const plansDir = join(tmp, "docs", "development");
		const result = computePlanPath(plansDir, "feature.md");
		expect(result).toBe(join(plansDir, "001-impl-feature.md"));
	});
});
