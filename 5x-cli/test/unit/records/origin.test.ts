/**
 * Tests for resolveRecordPerformer fallback rules.
 */

import { describe, expect, test } from "bun:test";
import { resolveRecordPerformer } from "../../../src/records/origin.js";

describe("resolveRecordPerformer", () => {
	test("explicit performer wins and is copied without filling provider", () => {
		const performer = { kind: "agent" as const, role: "author" };
		const resolved = resolveRecordPerformer({
			stepName: "git:commit",
			performer,
		});
		expect(resolved).toEqual({ kind: "agent", role: "author" });
		expect(resolved.provider).toBeUndefined();
	});

	test("human:* without performer is operator", () => {
		expect(resolveRecordPerformer({ stepName: "human:approve" })).toEqual({
			kind: "human",
			role: "operator",
		});
	});

	test("git:commit without performer is system/cli", () => {
		expect(resolveRecordPerformer({ stepName: "git:commit" })).toEqual({
			kind: "system",
			role: "cli",
		});
	});

	test("run:complete and run:abort are system/cli", () => {
		expect(resolveRecordPerformer({ stepName: "run:complete" })).toEqual({
			kind: "system",
			role: "cli",
		});
		expect(resolveRecordPerformer({ stepName: "run:abort" })).toEqual({
			kind: "system",
			role: "cli",
		});
	});

	test("quality:* is system/cli", () => {
		expect(resolveRecordPerformer({ stepName: "quality:check" })).toEqual({
			kind: "system",
			role: "cli",
		});
	});

	test("unknown / omitted step is system/cli and never guesses agent", () => {
		expect(resolveRecordPerformer({ stepName: "author:impl:status" })).toEqual({
			kind: "system",
			role: "cli",
		});
		expect(resolveRecordPerformer({})).toEqual({
			kind: "system",
			role: "cli",
		});
	});
});
