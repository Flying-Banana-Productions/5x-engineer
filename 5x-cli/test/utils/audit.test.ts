import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendStructuredAuditRecord } from "../../src/utils/audit.js";

describe("appendStructuredAuditRecord", () => {
	function createTmpFile(): { filePath: string; cleanup: () => void } {
		const tmp = mkdtempSync(join(tmpdir(), "5x-audit-"));
		const filePath = join(tmp, "review.md");
		// Create the file with some initial content
		const { writeFileSync } = require("node:fs");
		writeFileSync(filePath, "# Review\n\nSome content.\n");
		return {
			filePath,
			cleanup: () => rmSync(tmp, { recursive: true, force: true }),
		};
	}

	test("append-only: multiple calls accumulate, never overwrite", async () => {
		const { filePath, cleanup } = createTmpFile();
		try {
			await appendStructuredAuditRecord(filePath, { type: "first" });
			await appendStructuredAuditRecord(filePath, { type: "second" });
			await appendStructuredAuditRecord(filePath, { type: "third" });

			const content = readFileSync(filePath, "utf-8");
			// Original content preserved
			expect(content).toContain("# Review");
			expect(content).toContain("Some content.");

			// Count audit records
			const matches = content.match(/<!-- 5x:structured:v1 /g);
			expect(matches).toHaveLength(3);
		} finally {
			cleanup();
		}
	});

	test("format: each appended line matches <!-- 5x:structured:v1 <base64url> -->", async () => {
		const { filePath, cleanup } = createTmpFile();
		try {
			await appendStructuredAuditRecord(filePath, {
				schema: 1,
				type: "verdict",
			});

			const content = readFileSync(filePath, "utf-8");
			const pattern = /<!-- 5x:structured:v1 ([A-Za-z0-9_-]+) -->/;
			expect(content).toMatch(pattern);
		} finally {
			cleanup();
		}
	});

	test("round-trip: decoded payload equals original record object", async () => {
		const { filePath, cleanup } = createTmpFile();
		try {
			const original = {
				schema: 1,
				type: "verdict",
				phase: "-1",
				iteration: 0,
				data: {
					readiness: "ready",
					items: [],
				},
			};

			await appendStructuredAuditRecord(filePath, original);

			const content = readFileSync(filePath, "utf-8");
			const match = content.match(/<!-- 5x:structured:v1 ([A-Za-z0-9_-]+) -->/);
			expect(match).toBeTruthy();

			const payload = match?.[1];
			expect(payload).toBeDefined();
			const decoded = JSON.parse(
				Buffer.from(payload as string, "base64url").toString("utf8"),
			);
			expect(decoded).toEqual(original);
		} finally {
			cleanup();
		}
	});

	test("encoding safety: payload containing --> or -- does not break comment delimiter", async () => {
		const { filePath, cleanup } = createTmpFile();
		try {
			const record = {
				reason: "This has --> in it and also -- dashes",
				title: "Something with --> arrows",
			};

			await appendStructuredAuditRecord(filePath, record);

			const content = readFileSync(filePath, "utf-8");

			// The base64url encoding should prevent any raw --> in the comment
			// Count comment close markers: original file has none, we add exactly one
			const closeTags = content.match(/-->/g);
			expect(closeTags).toHaveLength(1); // only our audit comment close

			// Verify round-trip
			const match = content.match(/<!-- 5x:structured:v1 ([A-Za-z0-9_-]+) -->/);
			expect(match).toBeTruthy();
			const payload = match?.[1];
			expect(payload).toBeDefined();
			const decoded = JSON.parse(
				Buffer.from(payload as string, "base64url").toString("utf8"),
			);
			expect(decoded).toEqual(record);
		} finally {
			cleanup();
		}
	});
});
