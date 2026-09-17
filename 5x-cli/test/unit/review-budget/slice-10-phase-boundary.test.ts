import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Phase 4 persistence boundary", () => {
	test("facade, codec, index, and tests do not depend on the live record context", () => {
		const files = [
			"../../../src/control-plane/review-budget-store.ts",
			"../../../src/review-budget/record-lines.ts",
			"../../../src/control-plane/review-budget-index.ts",
			"../control-plane/review-budget-store-contract.test.ts",
			"../control-plane/review-budget-index.test.ts",
			"record-lines.test.ts",
		];
		const forbiddenIdentifier = ["create", "Record", "Context"].join("");
		const forbiddenModule = ["record", "-", "context"].join("");
		for (const relative of files) {
			const text = readFileSync(join(import.meta.dir, relative), "utf8");
			expect(text).not.toContain(forbiddenIdentifier);
			expect(text).not.toContain(forbiddenModule);
			expect(text).not.toContain("src/protocol");
		}
	});
});

describe("Phase 6 command context boundary", () => {
	test("review budget context delegates attribution and store creation to createRecordContext", () => {
		const text = readFileSync(
			join(import.meta.dir, "../../../src/commands/review-budget-context.ts"),
			"utf8",
		);
		expect(text).toContain(
			'import { createRecordContext } from "./record-context.js"',
		);
		expect(text).toContain("await createRecordContext(...args)");
		expect(text).not.toContain("createRecordAttribution");
	});
});
