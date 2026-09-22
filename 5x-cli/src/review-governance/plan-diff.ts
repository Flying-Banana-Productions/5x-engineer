import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { subprocess } from "../utils/subprocess.js";
import type { IntroducedByPlanHunk, PlanDiffContext } from "./types.js";

export type EvidenceValidation =
	| { valid: true; hunkHash: string }
	| {
			valid: false;
			code:
				| "PLAN_DIFF_CONTEXT_MISSING"
				| "INTRODUCED_RANGE_MISMATCH"
				| "INTRODUCED_HUNK_NOT_FOUND";
			message: string;
			closestHunkHeader?: string;
	  };

export class PlanDiffError extends Error {
	constructor(
		readonly code: "PLAN_DIFF_GIT_ERROR" | "PLAN_DIFF_BINARY_UNSUPPORTED",
		message: string,
	) {
		super(message);
		this.name = "PlanDiffError";
	}
}

export type PlanDiffFailure = Pick<PlanDiffError, "code" | "message">;

function normalizeTransport(value: string): string {
	return value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""))
		.join("\n")
		.replace(/\n+$/u, "");
}

function parseHunks(patch: string): PlanDiffContext["hunks"] {
	const normalized = normalizeTransport(patch);
	const lines = normalized.split("\n");
	const starts: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (
			/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/u.test(lines[index] ?? "")
		)
			starts.push(index);
	}
	return starts.map((start, position) => {
		let end = starts[position + 1] ?? lines.length;
		for (let index = start + 1; index < end; index += 1) {
			if ((lines[index] ?? "").startsWith("diff --git ")) {
				end = index;
				break;
			}
		}
		const text = normalizeTransport(lines.slice(start, end).join("\n"));
		return {
			header: lines[start] as string,
			text,
			hash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
		};
	});
}

async function git(workdir: string, args: string[]): Promise<string> {
	const result = await subprocess.execGit(args, workdir);
	if (result.exitCode !== 0)
		throw new PlanDiffError(
			"PLAN_DIFF_GIT_ERROR",
			result.stderr.trim() || `git ${args.join(" ")} failed`,
		);
	return result.stdout.trimEnd();
}

async function resolveCommit(workdir: string, commit: string): Promise<string> {
	return (
		await git(workdir, ["rev-parse", "--verify", `${commit}^{commit}`])
	).trim();
}

async function planPathspecs(
	workdir: string,
	from: string,
	to: string,
	planPath: string,
): Promise<{ root: string; displayPath: string; pathspecs: string[] }> {
	const root = (await git(workdir, ["rev-parse", "--show-toplevel"])).trim();
	const absolute = isAbsolute(planPath) ? planPath : resolve(workdir, planPath);
	const displayPath = relative(root, absolute).replaceAll("\\", "/");
	const names = await git(root, [
		"diff",
		"--name-status",
		"-M",
		`${from}..${to}`,
	]);
	const pathspecs = new Set([displayPath]);
	for (const line of names.split("\n")) {
		const [status, oldPath, newPath] = line.split("\t");
		if (status?.startsWith("R") && newPath === displayPath && oldPath)
			pathspecs.add(oldPath);
	}
	return { root, displayPath, pathspecs: [...pathspecs] };
}

async function planPatch(
	workdir: string,
	from: string,
	to: string,
	pathspecs: readonly string[],
): Promise<string> {
	const patch = await git(workdir, [
		"diff",
		"--find-renames",
		"--unified=3",
		`${from}..${to}`,
		"--",
		...pathspecs,
	]);
	if (/^(?:GIT binary patch|Binary files )/mu.test(patch))
		throw new PlanDiffError(
			"PLAN_DIFF_BINARY_UNSUPPORTED",
			"The plan-only diff is binary and cannot supply hunk evidence.",
		);
	return normalizeTransport(patch);
}

export async function buildPlanReviewDiffContext(input: {
	workdir: string;
	planPath: string;
	previousReviewCommit: string;
	currentCommit?: string;
}): Promise<PlanDiffContext> {
	const previousReviewCommit = await resolveCommit(
		input.workdir,
		input.previousReviewCommit,
	);
	const currentPlanCommit = await resolveCommit(
		input.workdir,
		input.currentCommit ?? "HEAD",
	);
	const { root, displayPath, pathspecs } = await planPathspecs(
		input.workdir,
		previousReviewCommit,
		currentPlanCommit,
		input.planPath,
	);
	const patch = await planPatch(
		root,
		previousReviewCommit,
		currentPlanCommit,
		pathspecs,
	);
	const revisions = (
		await git(root, [
			"rev-list",
			"--reverse",
			`${previousReviewCommit}..${currentPlanCommit}`,
		])
	)
		.split("\n")
		.filter(Boolean);
	const lastPlanCommit = (
		await git(root, [
			"rev-list",
			"-1",
			`${previousReviewCommit}..${currentPlanCommit}`,
			"--",
			...pathspecs,
		])
	).trim();
	let equivalentPlanCommits: string[];
	if (!lastPlanCommit) {
		equivalentPlanCommits = revisions;
	} else {
		const lastPlanIndex = revisions.indexOf(lastPlanCommit);
		const lastPlanPatch = await planPatch(
			root,
			previousReviewCommit,
			lastPlanCommit,
			pathspecs,
		);
		equivalentPlanCommits =
			lastPlanIndex >= 0 && lastPlanPatch === patch
				? revisions.slice(lastPlanIndex)
				: [currentPlanCommit];
	}
	return {
		previousReviewCommit,
		currentPlanCommit,
		planPath: displayPath,
		patch,
		hunks: parseHunks(patch),
		equivalentPlanCommits,
	};
}

function uniqueCommit(
	reference: string,
	commits: readonly string[],
): string | null {
	const matches = commits.filter((commit) => commit.startsWith(reference));
	return matches.length === 1 ? (matches[0] as string) : null;
}

function distance(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		let previous = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= right.length; j += 1) {
			const old = row[j] as number;
			row[j] = Math.min(
				(row[j] as number) + 1,
				(row[j - 1] as number) + 1,
				previous + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			previous = old;
		}
	}
	return row[right.length] as number;
}

export function validateIntroducedBy(
	evidence: IntroducedByPlanHunk,
	context: PlanDiffContext | undefined,
): EvidenceValidation {
	if (!context)
		return {
			valid: false,
			code: "PLAN_DIFF_CONTEXT_MISSING",
			message: "No exact plan-only diff context is available for this review.",
		};
	const range = /^([^\s.]+)\.\.([^\s.]+)$/u.exec(evidence.commitRange.trim());
	const commits = [
		...new Set([
			context.previousReviewCommit,
			context.currentPlanCommit,
			...(context.equivalentPlanCommits ?? []),
		]),
	];
	const start = range ? uniqueCommit(range[1] as string, commits) : null;
	const end = range ? uniqueCommit(range[2] as string, commits) : null;
	if (
		!start ||
		start !== context.previousReviewCommit ||
		!end ||
		!(context.equivalentPlanCommits ?? [context.currentPlanCommit]).includes(
			end,
		)
	)
		return {
			valid: false,
			code: "INTRODUCED_RANGE_MISMATCH",
			message: `Introducing range must start at ${context.previousReviewCommit} and end at a commit with the same plan-only patch as ${context.currentPlanCommit}.`,
		};
	const cited = normalizeTransport(evidence.diffHunk);
	const match = context.hunks.find((hunk) => hunk.text === cited);
	if (match) return { valid: true, hunkHash: match.hash };
	const citedHeader = cited.split("\n")[0] ?? "";
	const closest = [...context.hunks].sort(
		(left, right) =>
			distance(citedHeader, left.header) - distance(citedHeader, right.header),
	)[0]?.header;
	return {
		valid: false,
		code: "INTRODUCED_HUNK_NOT_FOUND",
		message: closest
			? `The cited complete hunk is not in the plan-only diff; closest hunk is ${closest}.`
			: "The cited complete hunk is not in the plan-only diff, which has no text hunks.",
		...(closest ? { closestHunkHeader: closest } : {}),
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatPlanReviewDiffContext(
	context: PlanDiffContext,
	maxLines = 200,
): string {
	const lines = context.patch ? context.patch.split("\n") : [];
	const shown = lines.slice(0, maxLines);
	let searchFrom = 0;
	const omittedHeaders = context.hunks.flatMap((hunk) => {
		const start = lines.indexOf(hunk.header, searchFrom);
		if (start < 0) return [];
		searchFrom = start + 1;
		const end = start + hunk.text.split("\n").length;
		return start >= maxLines || end > maxLines ? [hunk.header] : [];
	});
	const range = `${context.previousReviewCommit}..${context.currentPlanCommit}`;
	const body = context.patch
		? `\`\`\`diff\n${shown.join("\n")}\n\`\`\``
		: "(plan file unchanged; changes may live in referenced artifacts)";
	const truncated = lines.length > maxLines;
	return (
		"\n## Plan Diff Since Last Review\n\n" +
		`Commit range: \`${range}\`\n\n${body}\n` +
		(truncated
			? `\n... (truncated, ${lines.length - maxLines} more lines)\n\nOmitted hunk headers:\n${omittedHeaders.map((header) => `- \`${header}\``).join("\n") || "- (none)"}\n`
			: "") +
		`\nRetrieve the complete plan-only diff with:\n\n\`git diff ${range} -- ${shellQuote(`:(top)${context.planPath}`)}\`\n`
	);
}

export function formatPlanReviewDiffFailure(input: {
	previousReviewCommit: string;
	currentCommit: string;
	error: Pick<PlanDiffError, "code" | "message">;
}): string {
	const range = `${input.previousReviewCommit}..${input.currentCommit}`;
	return (
		"\n## Plan Diff Since Last Review\n\n" +
		`Commit range: \`${range}\`\n\n` +
		`The exact plan-only diff could not be built (\`${input.error.code}\`): ${input.error.message}\n`
	);
}
