/**
 * Fixtures for the `5x-issue-resolution` skill's executable recipes.
 *
 * The skill documents its discovery, delivery-identity, refresh, and
 * publication procedures as `# recipe: <name>` bash blocks. These helpers
 * extract those blocks from the rendered skill, run them with real `git`
 * against temp repositories, and put a stub `gh` (and `5x`) on PATH that
 * records argv, rejects flags the installed `gh` does not accept, and serves
 * fixture JSON. They prove the recipes behave as written, not that an agent
 * follows them.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderSkillByName } from "../../src/skills/loader.js";
import { createRenderContext } from "../../src/skills/renderer.js";
import { cleanGitEnv } from "./clean-env.js";
import { commitAll, copyInitializedRepo } from "./git-fixture.js";

// ---------------------------------------------------------------------------
// Recipe extraction and execution
// ---------------------------------------------------------------------------

export function issueResolutionSkill(): string {
	return renderSkillByName("5x-issue-resolution", createRenderContext(false))
		.content;
}

/** Return the body of the fenced bash block headed `# recipe: <name>`. */
export function extractRecipe(content: string, name: string): string {
	const pattern = /```bash\n([\s\S]*?)```/g;
	const found: string[] = [];
	for (const match of content.matchAll(pattern)) {
		const body = match[1] ?? "";
		if (body.startsWith(`# recipe: ${name}\n`)) found.push(body);
	}
	if (found.length !== 1) {
		throw new Error(`expected one recipe "${name}", found ${found.length}`);
	}
	return found[0] as string;
}

export function listRecipeNames(content: string): string[] {
	const names: string[] = [];
	for (const match of content.matchAll(/```bash\n# recipe: ([a-z-]+)\n/g)) {
		if (match[1]) names.push(match[1]);
	}
	return names;
}

export type RecipeResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	lines: string[];
};

export async function runRecipe(
	name: string,
	opts: { cwd: string; env: Record<string, string>; binDir?: string },
): Promise<RecipeResult> {
	const script = extractRecipe(issueResolutionSkill(), name);
	const scriptDir = mkdtempSync(join(tmpdir(), "5x-recipe-"));
	const scriptPath = join(scriptDir, `${name}.sh`);
	writeFileSync(scriptPath, script);
	const base = cleanGitEnv();
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	Object.assign(env, opts.env);
	if (opts.binDir) env.PATH = `${opts.binDir}:${env.PATH ?? ""}`;
	try {
		const proc = Bun.spawn(["bash", scriptPath], {
			cwd: opts.cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return {
			exitCode,
			stdout,
			stderr,
			lines: stdout.split("\n").filter((line) => line.length > 0),
		};
	} finally {
		rmSync(scriptDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Git repositories
// ---------------------------------------------------------------------------

export async function git(dir: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout.trim();
}

export class FixtureRepo {
	readonly dir: string;
	private constructor(dir: string) {
		this.dir = dir;
	}

	static create(root: string, name = "repo"): FixtureRepo {
		const dir = join(root, name);
		copyInitializedRepo(dir);
		return new FixtureRepo(dir);
	}

	/** Write (string) or delete (null) files, then commit all. Returns the sha. */
	async commit(
		message: string,
		files: Record<string, string | null>,
	): Promise<string> {
		for (const [path, content] of Object.entries(files)) {
			const full = join(this.dir, path);
			if (content === null) {
				rmSync(full, { force: true });
			} else {
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}
		return commitAll(this.dir, message);
	}

	git(args: string[]): Promise<string> {
		return git(this.dir, args);
	}
}

export function makeTempRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `5x-${prefix}-`));
}

// ---------------------------------------------------------------------------
// Run record lines (shapes match src/review-budget/record-lines.ts)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function line(stream: string, payload: Json): string {
	return JSON.stringify({
		schema_version: 1,
		stream,
		idempotency_key: `${stream}:${String(payload.kind ?? payload.step_name)}:${Math.random()}`,
		created_at: "2026-11-05 12:00:00",
		provenance: "recorded",
		origin: { performer: { kind: "system", role: "cli" } },
		payload,
	});
}

export const rec = {
	binding(id: string, approvedPlanCommit: string): string {
		return line("budget", {
			kind: "implementation-binding",
			version: 1,
			id,
			executionRunId: "run_impl",
			sourceRunId: "run_plan",
			approvedPlanCommit,
			mode: "enforced",
		});
	},
	compatibility(): string {
		return line("budget", {
			kind: "implementation-compatibility",
			version: 1,
			id: "compat-1",
			executionRunId: "run_impl",
			reason: "budget_absent",
			observedMode: "off",
		});
	},
	context(
		id: string,
		bindingId: string,
		phase: string,
		baseCommit: string,
		reviewedCommit: string,
	): string {
		return line("budget", {
			kind: "implementation-review-context",
			version: 1,
			id,
			executionRunId: "run_impl",
			bindingId,
			phase,
			baseCommit,
			reviewedCommit,
			patchHash: "sha256:x",
			excludedPaths: [],
			hunks: [],
			binaryPaths: [],
		});
	},
	observation(input: {
		id: string;
		bindingId: string;
		contextId: string;
		phase: string;
		route: "complete" | "author_revision" | "final_corrections" | "human_gate";
		completionAuthorized: boolean;
		claimObservations?: Json[];
	}): string {
		return line("budget", {
			kind: "implementation-review",
			version: 1,
			runId: "run_impl",
			domain: "implementation",
			claimObservations: [],
			...input,
		});
	},
	correction(input: {
		observationId: string;
		bindingId: string;
		phase: string;
		commit: string;
		outcome?: "passed" | "failed" | "invalidated";
		qualityPassed?: boolean;
		carriedClaims?: Json[];
	}): string {
		return line("budget", {
			kind: "implementation-correction-attempt",
			version: 1,
			id: `attempt-${input.observationId}`,
			runId: "run_impl",
			observationId: input.observationId,
			sourceObservationId: input.observationId,
			phase: input.phase,
			bindingId: input.bindingId,
			authorCommit: input.commit,
			destinationCommit: input.commit,
			assessedCommit: input.commit,
			outcome: input.outcome ?? "passed",
			shortcutInvalidated: false,
			qualityPassed: input.qualityPassed ?? true,
			qualitySkipped: false,
			qualityTimedOut: false,
			architectureDelta: 0,
			boundaryChanges: [],
			inventoryClean: true,
			boundaryUncertain: false,
			carriedClaims: input.carriedClaims ?? [],
		});
	},
	preAuthor(bindingId: string, phase: string, preAuthorCommit: string): string {
		return line("steps", {
			step_name: "implementation:pre-author",
			phase,
			iteration: 0,
			result_json: {
				kind: "phase-author-admission",
				version: 1,
				bindingId,
				phase,
				preAuthorCommit,
			},
			head_commit: preAuthorCommit,
		});
	},
	reviewerStep(
		phase: string,
		headCommit: string,
		result: Json = { readiness: "ready" },
	): string {
		return line("steps", {
			step_name: "reviewer:commit",
			phase,
			iteration: 0,
			result_json: result,
			head_commit: headCommit,
		});
	},
};

/** Write budget.jsonl, steps.jsonl, and run.json into a fresh record dir. */
export function writeRunRecords(
	root: string,
	input: { budget: string[]; steps: string[]; finalHead: string },
): string {
	const rd = join(root, "records", "run_impl");
	mkdirSync(rd, { recursive: true });
	writeFileSync(
		join(rd, "budget.jsonl"),
		input.budget.map((l) => `${l}\n`).join(""),
	);
	writeFileSync(
		join(rd, "steps.jsonl"),
		input.steps.map((l) => `${l}\n`).join(""),
	);
	writeFileSync(
		join(rd, "run.json"),
		JSON.stringify({
			id: "run_impl",
			status: "completed",
			final_head_commit: input.finalHead,
		}),
	);
	return rd;
}

// ---------------------------------------------------------------------------
// Stub gh / 5x
// ---------------------------------------------------------------------------

export type StubComment = {
	id: number;
	body: string;
	user: { login: string };
	created_at: string;
	updated_at: string;
};

export type StubPr = {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefName: string;
	url: string;
	body: string;
};

export type StubState = {
	login: string;
	issue: { state: "OPEN" | "CLOSED"; title: string; body: string };
	comments: StubComment[];
	timeline: Json[];
	prs: StubPr[];
	behaviors: {
		/** ok | fail | timeout-created | timeout-lost */
		commentCreate?: string;
		/** ok | fail */
		commentUpdate?: string;
		/** ok | fail | fail-after-write */
		commentsList?: string;
		/** ok | fail | timeout-closed */
		close?: string;
		/** ok | fail | lost */
		prCreate?: string;
	};
	log: string[][];
	invalid: string[];
	nextId: number;
	writes: number;
};

const ISSUE_VIEW_FIELDS = [
	"assignees",
	"author",
	"blockedBy",
	"blocking",
	"body",
	"closed",
	"closedAt",
	"closedByPullRequestsReferences",
	"comments",
	"createdAt",
	"id",
	"isPinned",
	"issueType",
	"labels",
	"milestone",
	"number",
	"parent",
	"projectCards",
	"projectItems",
	"reactionGroups",
	"state",
	"stateReason",
	"subIssues",
	"subIssuesSummary",
	"title",
	"updatedAt",
	"url",
];

const PR_FIELDS = [
	"additions",
	"assignees",
	"author",
	"autoMergeRequest",
	"baseRefName",
	"baseRefOid",
	"body",
	"changedFiles",
	"closed",
	"closedAt",
	"closingIssuesReferences",
	"comments",
	"commits",
	"createdAt",
	"deletions",
	"files",
	"fullDatabaseId",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"id",
	"isCrossRepository",
	"isDraft",
	"labels",
	"latestReviews",
	"maintainerCanModify",
	"mergeCommit",
	"mergeStateStatus",
	"mergeable",
	"mergedAt",
	"mergedBy",
	"milestone",
	"number",
	"potentialMergeCommit",
	"projectCards",
	"projectItems",
	"reactionGroups",
	"reviewDecision",
	"reviewRequests",
	"reviews",
	"state",
	"statusCheckRollup",
	"title",
	"updatedAt",
	"url",
];

/**
 * Flags accepted by gh 2.101.0 for each subcommand the skill uses (checked
 * against `gh <cmd> --help`). Value-taking flags map to true.
 */
const GH_FLAGS: Record<string, Record<string, boolean>> = {
	api: {
		"--paginate": false,
		"--slurp": false,
		"-X": true,
		"--method": true,
		"-F": true,
		"--field": true,
		"-f": true,
		"--raw-field": true,
		"-q": true,
		"--jq": true,
	},
	"issue view": { "--repo": true, "-R": true, "--json": true, "-q": true },
	"issue comment": {
		"--repo": true,
		"-R": true,
		"--body-file": true,
		"-F": true,
		"--body": true,
		"-b": true,
	},
	"issue close": {
		"--repo": true,
		"-R": true,
		"--reason": true,
		"-r": true,
		"--comment": true,
		"-c": true,
	},
	"pr list": {
		"--repo": true,
		"-R": true,
		"--head": true,
		"-H": true,
		"--base": true,
		"-B": true,
		"--state": true,
		"-s": true,
		"--search": true,
		"-S": true,
		"--json": true,
		"--limit": true,
		"-L": true,
	},
	"pr create": {
		"--repo": true,
		"-R": true,
		"--base": true,
		"-B": true,
		"--head": true,
		"-H": true,
		"--title": true,
		"-t": true,
		"--body-file": true,
		"-F": true,
		"--body": true,
		"-b": true,
	},
	"pr edit": {
		"--repo": true,
		"-R": true,
		"--body-file": true,
		"-F": true,
		"--body": true,
		"-b": true,
		"--title": true,
		"-t": true,
	},
	"pr view": { "--repo": true, "-R": true, "--json": true },
	"repo view": { "--json": true },
};

const STUB_SOURCE = `
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.GH_STUB_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);
const FLAGS = ${JSON.stringify(GH_FLAGS)};
const ISSUE_FIELDS = new Set(${JSON.stringify(ISSUE_VIEW_FIELDS)});
const PR_FIELDS = new Set(${JSON.stringify(PR_FIELDS)});
state.log.push(argv);
function save() { writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function fail(msg, code) { process.stderr.write(msg + "\\n"); save(); process.exit(code); }
function invalid(msg) { state.invalid.push(msg + ": " + argv.join(" ")); fail("invalid: " + msg, 2); }
const top = argv[0];
const cmd = top === "api" ? "api" : argv[0] + " " + argv[1];
const spec = FLAGS[cmd];
if (!spec) invalid("unknown command " + cmd);
const rest = top === "api" ? argv.slice(1) : argv.slice(2);
const flags = {}; const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("-")) {
    if (!(a in spec)) invalid("unknown flag " + a + " for " + cmd);
    if (spec[a]) { flags[a] = rest[++i]; if (flags[a] === undefined) invalid("missing value for " + a); }
    else flags[a] = true;
  } else positional.push(a);
}
const get = (...names) => { for (const n of names) if (flags[n] !== undefined) return flags[n]; return undefined; };
function checkJson(fields, allowed) {
  if (fields === undefined) return [];
  const list = fields.split(",");
  for (const f of list) if (!allowed.has(f)) invalid("unknown json field " + f);
  return list;
}
function pick(obj, fields) { const out = {}; for (const f of fields) out[f] = obj[f] === undefined ? null : obj[f]; return out; }
function pages(arr) {
  if (arr.length === 0) return "[]\\n";
  let out = ""; for (let i = 0; i < arr.length; i += 2) out += JSON.stringify(arr.slice(i, i + 2)) + "\\n"; return out;
}
const now = () => new Date(Date.UTC(2026, 10, 6, 0, 0, state.nextId)).toISOString().replace(/\\.\\d+Z$/, "Z");
const repo = get("--repo", "-R");
if (top !== "api" && cmd !== "repo view" && repo !== "OWNER/REPO") invalid("wrong repo " + repo);

if (cmd === "api") {
  const method = get("-X", "--method") || "GET";
  const endpoint = positional[0];
  if (endpoint === "user") { process.stdout.write(JSON.stringify({ login: state.login }) + "\\n"); save(); process.exit(0); }
  if (method === "GET" && /^repos\\/OWNER\\/REPO\\/issues\\/42\\/comments$/.test(endpoint)) {
    if (!flags["--paginate"]) invalid("comments list without --paginate");
    const b = state.behaviors.commentsList || "ok";
    if (b === "fail" || (b === "fail-after-write" && state.writes > 0)) fail("HTTP 502", 1);
    process.stdout.write(pages(state.comments)); save(); process.exit(0);
  }
  if (method === "GET" && /^repos\\/OWNER\\/REPO\\/issues\\/42\\/timeline$/.test(endpoint)) {
    if (!flags["--paginate"]) invalid("timeline without --paginate");
    process.stdout.write(pages(state.timeline)); save(); process.exit(0);
  }
  const m = /^repos\\/OWNER\\/REPO\\/issues\\/comments\\/(\\d+)$/.exec(endpoint || "");
  if (method === "PATCH" && m) {
    const field = get("-F", "--field") || "";
    if (!field.startsWith("body=@")) invalid("PATCH without body=@file");
    state.writes++;
    if ((state.behaviors.commentUpdate || "ok") === "fail") fail("HTTP 500", 1);
    const c = state.comments.find((x) => String(x.id) === m[1]);
    if (!c) fail("HTTP 404", 1);
    c.body = readFileSync(field.slice(6), "utf8"); c.updated_at = now();
    process.stdout.write(JSON.stringify(c) + "\\n"); save(); process.exit(0);
  }
  invalid("unhandled api " + method + " " + endpoint);
}
if (cmd === "issue view") {
  if (positional[0] !== "42") invalid("wrong issue");
  const fields = checkJson(get("--json"), ISSUE_FIELDS);
  process.stdout.write(JSON.stringify(pick(state.issue, fields)) + "\\n"); save(); process.exit(0);
}
if (cmd === "issue comment") {
  if (positional[0] !== "42") invalid("wrong issue");
  const file = get("--body-file", "-F");
  if (!file) invalid("comment without --body-file");
  state.writes++;
  const b = state.behaviors.commentCreate || "ok";
  if (b === "fail" || b === "timeout-lost") fail(b === "fail" ? "HTTP 500" : "timeout", b === "fail" ? 1 : 124);
  const c = { id: state.nextId++, body: readFileSync(file, "utf8"), user: { login: state.login }, created_at: now(), updated_at: now() };
  state.comments.push(c);
  if (b === "timeout-created") fail("timeout", 124);
  process.stdout.write("https://github.com/OWNER/REPO/issues/42#issuecomment-" + c.id + "\\n"); save(); process.exit(0);
}
if (cmd === "issue close") {
  if (positional[0] !== "42") invalid("wrong issue");
  const reason = get("--reason", "-r");
  if (!["completed", "not planned", "duplicate"].includes(reason)) invalid("bad reason " + reason);
  state.writes++;
  const b = state.behaviors.close || "ok";
  if (b === "fail") fail("HTTP 500", 1);
  state.issue.state = "CLOSED";
  if (b === "timeout-closed") fail("timeout", 124);
  save(); process.exit(0);
}
if (cmd === "pr list") {
  const st = get("--state", "-s");
  if (st !== undefined && !["open", "closed", "merged", "all"].includes(st)) invalid("bad state " + st);
  const fields = checkJson(get("--json"), PR_FIELDS);
  const head = get("--head", "-H");
  const prs = state.prs.filter((p) => head === undefined || p.headRefName === head);
  process.stdout.write(JSON.stringify(prs.map((p) => pick(p, fields))) + "\\n"); save(); process.exit(0);
}
if (cmd === "pr create") {
  for (const f of [["--base", "-B"], ["--head", "-H"], ["--title", "-t"]]) if (!get(...f)) invalid("pr create missing " + f[0]);
  const file = get("--body-file", "-F");
  if (!file) invalid("pr create without --body-file");
  state.writes++;
  const b = state.behaviors.prCreate || "ok";
  if (b === "fail") fail("HTTP 500", 1);
  const pr = { number: 57, state: "OPEN", headRefName: get("--head", "-H"), url: "https://github.com/OWNER/REPO/pull/57", body: readFileSync(file, "utf8") };
  state.prs.push(pr);
  if (b === "lost") fail("timeout", 124);
  process.stdout.write(pr.url + "\\n"); save(); process.exit(0);
}
if (cmd === "pr edit") {
  const file = get("--body-file", "-F");
  if (!file) invalid("pr edit without --body-file");
  state.writes++;
  const pr = state.prs.find((p) => String(p.number) === positional[0]);
  if (!pr) fail("no pr", 1);
  pr.body = readFileSync(file, "utf8");
  save(); process.exit(0);
}
invalid("unhandled " + cmd);
`;

/** Create a bin dir with stub `gh` and `5x`, plus a state file. */
export function makeStubBin(
	root: string,
	state: Partial<StubState> = {},
): { binDir: string; statePath: string; read(): StubState } {
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const ghPath = join(binDir, "gh");
	writeFileSync(ghPath, `#!${process.execPath}\n${STUB_SOURCE}`);
	chmodSync(ghPath, 0o755);
	const fivexPath = join(binDir, "5x");
	writeFileSync(
		fivexPath,
		`#!/bin/sh\necho "$@" >> "${join(root, "5x.log")}"\necho '{"ok":true,"data":{"runs":[]}}'\n`,
	);
	chmodSync(fivexPath, 0o755);
	const statePath = join(root, "gh-state.json");
	const full: StubState = {
		login: "five-x-bot",
		issue: { state: "OPEN", title: "Bug", body: "Broken" },
		comments: [],
		timeline: [],
		prs: [],
		behaviors: {},
		log: [],
		invalid: [],
		nextId: 1000,
		writes: 0,
		...state,
	};
	writeFileSync(statePath, JSON.stringify(full, null, 2));
	return {
		binDir,
		statePath,
		read: () => JSON.parse(readFileSync(statePath, "utf8")) as StubState,
	};
}

export function cleanupRoot(root: string): void {
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
