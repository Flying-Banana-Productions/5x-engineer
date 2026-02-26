import { describe, expect, test } from "bun:test";
import {
	type AuthorStatus,
	assertAuthorStatus,
	assertReviewerVerdict,
	type ReviewerVerdict,
} from "../src/protocol.js";

describe("assertAuthorStatus", () => {
	test("passes for complete + commit in phase execution", () => {
		const status: AuthorStatus = {
			result: "complete",
			commit: "abc123",
		};

		expect(() =>
			assertAuthorStatus(status, "EXECUTE", { requireCommit: true }),
		).not.toThrow();
	});

	test("passes for needs_human + reason", () => {
		const status: AuthorStatus = {
			result: "needs_human",
			reason: "Ambiguous requirement",
		};

		expect(() => assertAuthorStatus(status, "EXECUTE")).not.toThrow();
	});

	test("passes for failed + reason", () => {
		const status: AuthorStatus = {
			result: "failed",
			reason: "Command failed",
		};

		expect(() => assertAuthorStatus(status, "EXECUTE")).not.toThrow();
	});

	test("throws when complete + requireCommit without commit", () => {
		const status: AuthorStatus = { result: "complete" };

		expect(() =>
			assertAuthorStatus(status, "EXECUTE", { requireCommit: true }),
		).toThrow("result is 'complete' but 'commit' is missing");
	});

	test("throws when non-complete status has no reason", () => {
		expect(() =>
			assertAuthorStatus({ result: "needs_human" }, "EXECUTE"),
		).toThrow("reason' is missing");

		expect(() => assertAuthorStatus({ result: "failed" }, "EXECUTE")).toThrow(
			"reason' is missing",
		);
	});
});

describe("assertReviewerVerdict", () => {
	test("passes for ready + empty items", () => {
		const verdict: ReviewerVerdict = {
			readiness: "ready",
			items: [],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).not.toThrow();
	});

	test("passes for not_ready + actionable item", () => {
		const verdict: ReviewerVerdict = {
			readiness: "not_ready",
			items: [
				{
					id: "P0.1",
					title: "Fix bug",
					action: "auto_fix",
					reason: "Mechanical",
				},
			],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).not.toThrow();
	});

	test("throws when non-ready has no items", () => {
		const verdict: ReviewerVerdict = {
			readiness: "not_ready",
			items: [],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"items' is empty",
		);
	});

	test("throws when item action is missing at runtime", () => {
		const verdict = {
			readiness: "ready_with_corrections",
			items: [
				{
					id: "P1.2",
					title: "Missing action",
					reason: "Incomplete payload",
				},
			],
		} as unknown as ReviewerVerdict;

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"missing 'action'",
		);
	});
});
