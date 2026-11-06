/**
 * Keeps the resume/failure matrix and the `5x-issue-resolution` skill in
 * sync. This is documentation consistency, not agent behavior: it checks
 * that every scenario's outcome is in the skill's vocabulary and that the
 * rule it relies on is written in the skill.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";

type Row = {
	id: string;
	scenario: string;
	expected_outcome: string;
	rule: string;
};

const matrix = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../../fixtures/issue-resolution/resume-matrix.json"),
		"utf8",
	),
) as { rows: Row[] };

const REQUIRED_IDS = [
	"intake-incomplete",
	"after-intake",
	"after-sealed-planning",
	"after-sealed-implementation",
	"pr-created-lost-response",
	"merged-squash-head-matches",
	"merged-changed-head",
	"closed-unmerged",
	"merged-close-failed",
	"existing-marker-comment-reused",
	"already-closed-externally",
	"reopened-material-change",
	"missing-acceptance-evidence",
	"pending-release-requirement",
	"non-ready-intake",
	"edited-existing-comment",
	"quoted-marker-scope-change",
	"nonmaterial-chatter",
	"comment-create-unconfirmed-readback",
	"uncovered-pre-admission-code",
	"uncovered-inter-phase-code",
	"prepared-unaccepted-context",
	"compatibility-without-endpoints",
	"unmarked-linked-pr",
	"second-resume-after-close",
	"externally-closed-before-reconciliation",
	"reopened-after-marked-close",
	"material-new-comment",
	"read-only-post-seal-refresh",
	"comment-create-timeout",
	"comment-update-failure",
	"close-timeout-after-comment",
	"denied-publication-authorization",
	"failed-push",
	"evidence-only-commits",
	"approved-final-correction",
	"unauthorized-code-change",
	"divergent-heads",
	"multiple-phases",
	"unbound-compatibility",
	"squash-merge",
	"second-resume-after-external-receipt",
	"workflow-receipt-later-external-close",
	"external-receipt-open-issue",
	"preflight-invalid-authenticated-marker-open",
	"preflight-duplicate-receipts-open",
	"preflight-duplicate-receipts-closed",
];

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function outcomeVocabulary(content: string): string[] {
	return content
		.slice(content.indexOf("## Outcomes"), content.indexOf("## Workflow"))
		.split("\n")
		.map((line) => /^\| `([a-z_]+)` \|/.exec(line)?.[1])
		.filter((name): name is string => Boolean(name));
}

describe("issue-resolution resume matrix", () => {
	const renders = [
		createRenderContext(true),
		createRenderContext(false),
		createRenderContext(false, true, false),
		createRenderContext(false, false, true),
	].map((ctx) => renderSkillByName("5x-issue-resolution", ctx).content);

	test("covers every required scenario exactly once", () => {
		const ids = matrix.rows.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of REQUIRED_IDS) expect(ids).toContain(id);
	});

	for (const row of matrix.rows) {
		test(`${row.id}: ${row.expected_outcome}`, () => {
			for (const content of renders) {
				expect(outcomeVocabulary(content)).toContain(row.expected_outcome);
				expect(normalize(content)).toContain(normalize(row.rule));
			}
		});
	}
});
