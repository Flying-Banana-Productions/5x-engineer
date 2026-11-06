import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "../../../src/skills/frontmatter.js";
import {
	listBaseSkillNames,
	renderSkillByName,
} from "../../../src/skills/loader.js";
import {
	createRenderContext,
	type SkillRenderContext,
} from "../../../src/skills/renderer.js";

const ISSUE_RESOLUTION_OUTCOMES = [
	"intake_incomplete",
	"needs_clarification",
	"blocked",
	"already_addressed",
	"duplicate",
	"not_proceeding",
	"planning_in_progress",
	"implementation_in_progress",
	"publication_pending",
	"awaiting_merge",
	"pr_closed_unmerged",
	"delivered_sync_pending",
	"resolved",
	"resolved_externally_closed_unverified",
	"needs_human",
];

const SRC = join(import.meta.dir, "../../../src");

type Combo = {
	label: string;
	ctx: SkillRenderContext;
	authorNative: boolean;
	reviewerNative: boolean;
};

const COMBOS: Combo[] = [
	{ label: "native/native", authorNative: true, reviewerNative: true },
	{ label: "invoke/invoke", authorNative: false, reviewerNative: false },
	{ label: "native/invoke", authorNative: true, reviewerNative: false },
	{ label: "invoke/native", authorNative: false, reviewerNative: true },
].map((c) => ({
	...c,
	ctx: createRenderContext(false, c.authorNative, c.reviewerNative),
}));

function render(ctx: SkillRenderContext): string {
	return renderSkillByName("5x-issue-resolution", ctx).content;
}

describe("5x-issue-resolution skill", () => {
	test("is registered and its frontmatter parses", () => {
		expect(listBaseSkillNames()).toContain("5x-issue-resolution");
		const content = render(createRenderContext(true));
		const fm = parseSkillFrontmatter(content);
		expect(fm.name).toBe("5x-issue-resolution");
		expect(fm.name).toMatch(/^[a-z0-9-]+$/);
		expect(fm.name.length).toBeLessThanOrEqual(64);
		expect(fm.description.length).toBeLessThanOrEqual(1024);
		for (const trigger of [
			"resolve GitHub issue",
			"resume resolution of issue",
			"fix issue #N using 5x",
		]) {
			expect(fm.description).toContain(trigger);
		}
	});

	for (const combo of COMBOS) {
		test(`${combo.label} renders only its delegation branches`, () => {
			const content = render(combo.ctx);
			if (combo.authorNative) {
				expect(content).toContain('subagent_type="5x-plan-author"');
				expect(content).toContain(
					"5x protocol validate author --run $PLAN_RUN \\\n  --record --step author:issue-intake --phase plan --require-commit",
				);
				expect(content).toContain("5x template render author-issue-intake");
				expect(content).not.toContain("5x invoke author");
				expect(content).toContain("[[NATIVE_CONTINUE_PARAM]]");
			} else {
				expect(content).toContain("5x invoke author author-issue-intake");
				expect(content).toContain(
					"--record --record-step author:issue-intake --phase plan",
				);
				expect(content).toContain(".data.result.result");
				expect(content).not.toContain("5x protocol validate author");
				expect(content).not.toContain('subagent_type="5x-plan-author"');
				expect(content).not.toContain("5x template render author-issue-intake");
			}
			if (combo.reviewerNative) {
				expect(content).toContain("`5x-reviewer` via Task tool");
				expect(content).not.toContain("`5x invoke reviewer ...`");
			} else {
				expect(content).toContain("`5x invoke reviewer ...`");
				expect(content).not.toContain("`5x-reviewer` via Task tool");
			}
			const anyNative = combo.authorNative || combo.reviewerNative;
			if (!anyNative) {
				expect(content).not.toContain("Task tool");
				expect(content).not.toContain("subagent_type");
				expect(content).not.toContain("5x protocol validate");
				expect(content).toContain("5x prompt choose");
			} else {
				expect(content).toContain("native UI");
			}
			if (combo.authorNative && combo.reviewerNative) {
				expect(content).not.toContain("5x invoke");
			}
			expect(content).not.toMatch(/\{\{[#/]?(if|else)/);
		});
	}

	test("contains the three markers, Refs, and no closing keywords outside prohibitions", () => {
		const content = render(createRenderContext(false));
		expect(content).toContain(
			"<!-- 5x:issue-source v1 github.com/OWNER/REPO#42 -->",
		);
		expect(content).toContain(
			"<!-- 5x:issue-resolution v1 source=github.com/OWNER/REPO#42 plan=",
		);
		expect(content).toContain(
			"<!-- 5x:issue-resolution-comment v1 source=github.com/OWNER/REPO#42 pr=",
		);
		expect(content).toContain("Refs github.com/OWNER/REPO#42");
		const prose = content.replace(/\s+/g, " ");
		const sentences = prose.split(/(?<=[.:])\s+(?=[A-Z-])/);
		const keyword = /\b(Fixes|Closes|Resolves)\b/;
		const offending = sentences.filter(
			(s) => keyword.test(s) && !/\b(Never|No)\b/.test(s),
		);
		expect(offending).toEqual([]);
		expect(sentences.some((s) => keyword.test(s))).toBe(true);
	});

	test("states the Receipt preflight ahead of closure branches a-g and both receipt kinds", () => {
		for (const combo of COMBOS) {
			const content = render(combo.ctx);
			const preflight = content.indexOf("**Receipt preflight (mandatory;");
			expect(preflight).toBeGreaterThan(-1);
			let last = preflight;
			for (const branch of ["a", "b", "c", "d", "e", "f", "g"]) {
				const at = content.indexOf(`\n- ${branch}. `, last);
				expect(at).toBeGreaterThan(last);
				last = at;
			}
			expect(content).toContain("There is no fallthrough branch");
			for (const kind of ["workflow", "external"]) {
				expect(content).toContain(
					`<!-- 5x:issue-resolution-comment v1 source=github.com/OWNER/REPO#42 pr=57 closure=${kind} -->`,
				);
			}
			expect(content).toContain(
				"`resolved_externally_closed_unverified` is terminal for its receipt",
			);
		}
	});

	test("contains the required gh, git, and 5x commands", () => {
		const content = render(createRenderContext(false));
		for (const required of [
			"gh repo view --json nameWithOwner,url,defaultBranchRef",
			"git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin",
			'git grep -F -l -e "$MARK"',
			"gh issue view $N --repo $OWNER_REPO --json url,closedByPullRequestsReferences",
			"gh api --paginate repos/$OWNER_REPO/issues/$N/timeline",
			"gh api --paginate repos/$OWNER_REPO/issues/$N/comments",
			'--search "$N in:title,body"',
			"gh issue view $N --repo $OWNER_REPO --json title,body,state,stateReason,updatedAt,closedAt,url",
			"gh pr view $PR --repo $OWNER_REPO --json state,mergedAt,mergeCommit,headRefOid,baseRefName,url,body",
			'gh issue comment "$N" --repo "$OWNER_REPO" --body-file "$COMMENT_FILE"',
			'gh api -X PATCH "repos/$OWNER_REPO/issues/comments/$ID" -F "body=@$COMMENT_FILE"',
			'gh issue close "$N" --repo "$OWNER_REPO" --reason completed',
			'gh pr create --repo "$OWNER_REPO" --base "$TARGET" --head "$BRANCH"',
			'gh pr list --repo "$OWNER_REPO" --head "$BRANCH" --state all',
			'git ls-remote --heads origin "$BRANCH"',
			'git push -u origin "$BRANCH"',
			"5x run init --plan $PLAN_PATH --worktree",
			"5x review implementation bind --run $IMPL_RUN --source-run $PLAN_RUN",
			"5x run complete --run $PLAN_RUN",
			"5x run complete --run $IMPL_RUN",
			'5x commit --run $PLAN_RUN --no-record -m "5x: checkpoint run records"',
			"--var prd_path=$BRIEF_DIR/brief.md",
			"5x run list --plan $PLAN_PATH",
		]) {
			expect(content).toContain(required);
		}
	});

	test("contains the verified delivery-identity record commands", () => {
		const content = render(createRenderContext(false));
		for (const command of [
			`jq -c 'select(.payload.kind=="implementation-binding") | .payload | {id,approvedPlanCommit,mode}' $RD/budget.jsonl`,
			`jq -c 'select(.payload.kind=="implementation-review-context") | .payload | {id,phase,baseCommit,reviewedCommit}' $RD/budget.jsonl`,
			`jq -c 'select(.payload.kind=="implementation-review") | .payload | {id,phase,bindingId,contextId,route,completionAuthorized,createdAt}' $RD/budget.jsonl`,
			`jq -c 'select(.payload.kind=="implementation-correction-attempt") | .payload | {phase,bindingId,observationId,sourceObservationId,authorCommit,destinationCommit,outcome,qualityPassed,qualitySkipped,qualityTimedOut,shortcutInvalidated}' $RD/budget.jsonl`,
			"jq -r '.final_head_commit' $RD/run.json",
			`jq -c 'select(.payload.step_name=="git:commit") | {phase:.payload.phase,hash:.payload.result_json.hash,files:.payload.result_json.files}' $RD/steps.jsonl`,
			"5x run state --run $IMPL_RUN | jq '.data.implementation_governance | {binding,reviewedRange}'",
			'git merge-base --is-ancestor "$BASE" "$FINAL"',
			'git merge-base --is-ancestor "$FINAL" "$PR_HEAD"',
			'git rev-list --reverse "$BASE..$PR_HEAD"',
			'git diff-tree --root --no-commit-id --name-only -r "$SHA"',
			"implementation:pre-author",
		]) {
			expect(content).toContain(command);
		}
	});

	test("passes --run explicitly at cross-run handoffs", () => {
		for (const combo of COMBOS) {
			const content = render(combo.ctx);
			expect(content).toContain("--run $PLAN_RUN");
			expect(content).toContain("--run $IMPL_RUN");
			expect(content).toContain(
				"Do not rely on `.5x/current-run` or chat history.",
			);
		}
	});

	test("defines exactly the outcome vocabulary", () => {
		const content = render(createRenderContext(false));
		const table = content
			.slice(content.indexOf("## Outcomes"), content.indexOf("## Workflow"))
			.split("\n")
			.map((line) => /^\| `([a-z_]+)` \|/.exec(line)?.[1])
			.filter((name): name is string => Boolean(name));
		expect(table).toEqual(ISSUE_RESOLUTION_OUTCOMES);
		expect(content).toContain("Only `resolved` means success.");
	});

	test("formats contain no heading or checkbox lines inside fenced text examples", () => {
		const content = render(createRenderContext(false));
		const formats = content.slice(
			content.indexOf("## Formats"),
			content.indexOf("## Invariants"),
		);
		for (const match of formats.matchAll(/```text\n([\s\S]*?)```/g)) {
			for (const line of (match[1] ?? "").split("\n")) {
				expect(line).not.toMatch(/^#/);
				expect(line).not.toMatch(/^\s*[-*] \[[ xX]\]/);
			}
		}
		expect(formats).toContain(
			'Awaiting merge. To continue: "Resume resolution of issue #42."',
		);
		expect(formats).toContain("Missing operation: comment-create");
	});

	test("foundation 5x skill only points at it", () => {
		const foundation = renderSkillByName(
			"5x",
			createRenderContext(true),
		).content;
		expect(foundation).toContain("5x-issue-resolution");
		expect(parseSkillFrontmatter(foundation).description).toContain(
			"5x-issue-resolution",
		);
		expect(foundation).not.toContain("5x:issue-source");
		expect(foundation).not.toContain("gh issue close");
		expect(foundation).not.toContain("Refs github.com");
	});

	test("both orchestrator agent files list it", () => {
		for (const path of [
			"harnesses/opencode/5x-orchestrator.md",
			"harnesses/cursor/5x-orchestrator.mdc",
		]) {
			const text = readFileSync(join(SRC, path), "utf8");
			expect(text).toContain("**5x-issue-resolution**");
			expect(text).toContain("operator authorization");
		}
	});
});
