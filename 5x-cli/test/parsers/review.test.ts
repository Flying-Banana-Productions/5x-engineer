import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseReviewSummary } from "../../src/parsers/review.js";

const REAL_REVIEW_PATH = resolve(
	import.meta.dir,
	"../../../docs/development/reviews/2026-02-15-5x-cli-implementation-plan-review.md",
);
const hasRealReview = existsSync(REAL_REVIEW_PATH);
const REAL_REVIEW = hasRealReview
	? readFileSync(REAL_REVIEW_PATH, "utf-8")
	: "";

describe("parseReviewSummary", () => {
	// Smoke tests against real review file — loose structural assertions only
	test.skipIf(!hasRealReview)("extracts subject from real review", () => {
		const summary = parseReviewSummary(REAL_REVIEW);
		expect(summary.subject).toContain("5x CLI");
	});

	test.skipIf(!hasRealReview)("extracts readiness from real review", () => {
		const summary = parseReviewSummary(REAL_REVIEW);
		// Readiness changes across addendums; just assert it's non-empty
		expect(summary.readiness.length).toBeGreaterThan(0);
	});

	test.skipIf(!hasRealReview)("counts P0 items from real review", () => {
		const summary = parseReviewSummary(REAL_REVIEW);
		expect(summary.p0Count).toBeGreaterThan(0);
	});

	test.skipIf(!hasRealReview)("counts P1 items from real review", () => {
		const summary = parseReviewSummary(REAL_REVIEW);
		expect(summary.p1Count).toBeGreaterThan(0);
	});

	test("parses minimal review", () => {
		const md = `# Review: Widget Feature

**Readiness:** Ready — all items addressed

## Production readiness blockers

No blockers.

## High priority (P1)

No high priority items.

## Medium priority (P2)

No medium priority items.
`;
		const summary = parseReviewSummary(md);
		expect(summary.subject).toBe("Widget Feature");
		expect(summary.readiness).toBe("Ready — all items addressed");
		expect(summary.p0Count).toBe(0);
		expect(summary.p1Count).toBe(0);
		expect(summary.p2Count).toBe(0);
		expect(summary.hasAddendums).toBe(false);
	});

	test("counts P0 and P1 headings", () => {
		const md = `# Review: Test

**Readiness:** Not ready

### P0.1 — Critical bug
Description.

### P0.2 — Another blocker
Description.

### P1.1 — Improvement
Description.

### P1.2 — Another one
Description.

### P1.3 — Third
Description.
`;
		const summary = parseReviewSummary(md);
		expect(summary.p0Count).toBe(2);
		expect(summary.p1Count).toBe(3);
	});

	test("counts P2 bullet items in Medium priority section", () => {
		const md = `# Review: Test

**Readiness:** Ready with corrections

## Medium priority (P2)

- **Logging**: Add structured logging
- **Docs**: Update API docs
- **Tests**: Add edge case tests

## Readiness checklist
`;
		const summary = parseReviewSummary(md);
		expect(summary.p2Count).toBe(3);
	});

	test("detects addendums", () => {
		const md = `# Review: Test

**Readiness:** Not ready

### P0.1 — Bug
Fix it.

## Addendum (2026-02-10) — First follow-up

### What's addressed
- Fixed the bug

## Addendum (2026-02-15) — Second follow-up

### What's addressed
- More fixes
`;
		const summary = parseReviewSummary(md);
		expect(summary.hasAddendums).toBe(true);
		expect(summary.latestAddendumDate).toBe("2026-02-15");
	});

	test("no addendums returns undefined date", () => {
		const md = `# Review: Simple

**Readiness:** Ready
`;
		const summary = parseReviewSummary(md);
		expect(summary.hasAddendums).toBe(false);
		expect(summary.latestAddendumDate).toBeUndefined();
	});

	test("handles 'Review:' prefix in title", () => {
		const md = `# Review: My Feature

**Readiness:** Ready
`;
		const summary = parseReviewSummary(md);
		expect(summary.subject).toBe("My Feature");
	});

	test("handles title without 'Review:' prefix", () => {
		const md = `# My Feature Review

**Readiness:** Ready
`;
		const summary = parseReviewSummary(md);
		expect(summary.subject).toBe("My Feature Review");
	});
});
