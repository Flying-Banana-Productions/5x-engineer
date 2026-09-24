/**
 * Exact implementation-review diffs.
 *
 * Whitespace is significant. A hunk citation is the `diff --git` file header
 * plus the complete `@@` hunk. Extended headers between those lines may be
 * present, as in a block copied from the rendered diff, and one missing
 * final newline is ignored. Other whitespace is not normalized. This module
 * does not accept a later commit with an equivalent patch as the reviewed end.
 */

import { createHash } from "node:crypto";
import type { ReviewerVerdict, VerdictItem } from "../protocol.js";
import type { ImplementationReviewHunk } from "../review-budget/record-lines.js";
import { subprocess } from "../utils/subprocess.js";
import type {
	ImplementationDiagnostic,
	IntroducedByPlanHunk,
} from "./types.js";

export const CODE_DIFF_OPTIONS = [
	"-c",
	"diff.external=",
	"-c",
	"diff.noprefix=false",
	"-c",
	"core.quotePath=false",
	"-c",
	"core.autocrlf=false",
	"diff",
	"--find-renames=50%",
	"--full-index",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--unified=3",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--diff-algorithm=myers",
	"--indent-heuristic",
	"--inter-hunk-context=0",
	"--no-relative",
] as const;

export type CodeDiffGitResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export interface CodeDiffGit {
	exec(
		args: string[],
		options?: { exact?: boolean },
	): Promise<CodeDiffGitResult>;
}

export function workdirCodeDiffGit(workdir: string): CodeDiffGit {
	return {
		exec(args, options) {
			return subprocess.execGit(args, workdir, options);
		},
	};
}

export class CodeDiffError extends Error {
	constructor(
		readonly code:
			| "CODE_DIFF_GIT_ERROR"
			| "CODE_DIFF_BAD_REF"
			| "CODE_DIFF_DIRTY"
			| "CODE_DIFF_NOT_ANCESTOR"
			| "CODE_DIFF_INTERVENING"
			| "CODE_DIFF_AMBIGUOUS_BASE"
			| "CODE_DIFF_MISSING_BASE"
			| "CODE_DIFF_STALE",
		message: string,
	) {
		super(message);
		this.name = "CodeDiffError";
	}
}

export interface CodeDiffContext {
	baseCommit: string;
	reviewedCommit: string;
	patch: string;
	patchHash: string;
	excludedPaths: string[];
	hunks: ImplementationReviewHunk[];
	binaryPaths: string[];
}

export type CodeHunkValidation =
	| { valid: true; hunkHash: string }
	| {
			valid: false;
			code:
				| "CODE_RANGE_MISMATCH"
				| "CODE_HUNK_NOT_FOUND"
				| "CODE_HUNK_WRONG_FILE"
				| "CODE_HUNK_CONTEXT_ONLY"
				| "CODE_HUNK_BINARY"
				| "CODE_HUNK_COMBINED"
				| "CODE_HUNK_WHITESPACE"
				| "CODE_HUNK_EVIDENCE_INCOMPLETE";
			message: string;
	  };

interface KeptLine {
	text: string;
	eol: string;
}

function hashText(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function splitLinesKeepEol(patch: string): KeptLine[] {
	const lines: KeptLine[] = [];
	let index = 0;
	while (index < patch.length) {
		const next = patch.indexOf("\n", index);
		if (next < 0) {
			lines.push({ text: patch.slice(index), eol: "" });
			break;
		}
		const hasCr = next > index && patch[next - 1] === "\r";
		lines.push({
			text: patch.slice(index, hasCr ? next - 1 : next),
			eol: hasCr ? "\r\n" : "\n",
		});
		index = next + 1;
	}
	return lines;
}

function joinLines(lines: readonly KeptLine[]): string {
	return lines.map((line) => `${line.text}${line.eol}`).join("");
}

function unquotePath(value: string): string {
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
		return value;
	}
	return value.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
}

function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } {
	const body = line.slice("diff --git ".length);
	if (body.startsWith('"')) {
		const end = body.indexOf('"', 1);
		const second = body.indexOf('"', end + 1);
		const third = body.indexOf('"', second + 1);
		if (end > 0 && second > end && third > second) {
			return {
				oldPath: stripAbPrefix(unquotePath(body.slice(0, end + 1))),
				newPath: stripAbPrefix(unquotePath(body.slice(second, third + 1))),
			};
		}
	}
	const marker = " b/";
	const splitAt = body.lastIndexOf(marker);
	if (splitAt <= 0) return { oldPath: body, newPath: body };
	return {
		oldPath: stripAbPrefix(body.slice(0, splitAt)),
		newPath: stripAbPrefix(body.slice(splitAt + 1)),
	};
}

function stripAbPrefix(path: string): string {
	if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
	return path;
}

function isChangedLine(text: string): boolean {
	if (text.startsWith("+++") || text.startsWith("---")) return false;
	return text.startsWith("+") || text.startsWith("-");
}

function hunkBody(text: string): string {
	const lines = splitLinesKeepEol(text);
	const start = lines.findIndex((line) => line.text.startsWith("@@"));
	if (start < 0) return text;
	return joinLines(lines.slice(start));
}

export function parseCodePatch(patch: string): {
	hunks: ImplementationReviewHunk[];
	binaryPaths: string[];
	/** Paths added by `new file mode` or `--- /dev/null`, including empty and binary files. */
	addedPaths: string[];
} {
	const lines = splitLinesKeepEol(patch);
	const fileStarts: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if ((lines[index]?.text ?? "").startsWith("diff --git "))
			fileStarts.push(index);
	}
	const hunks: ImplementationReviewHunk[] = [];
	const binaryPaths: string[] = [];
	const addedPaths: string[] = [];
	for (let fileIndex = 0; fileIndex < fileStarts.length; fileIndex += 1) {
		const start = fileStarts[fileIndex] as number;
		const end = fileStarts[fileIndex + 1] ?? lines.length;
		const section = lines.slice(start, end);
		const headerLine = section[0];
		if (!headerLine) continue;
		let paths = parseDiffGitPaths(headerLine.text);
		let binary = false;
		let combined = false;
		let added = false;
		for (const line of section) {
			if (line.text.startsWith("rename from "))
				paths = { ...paths, oldPath: line.text.slice("rename from ".length) };
			if (line.text.startsWith("rename to "))
				paths = { ...paths, newPath: line.text.slice("rename to ".length) };
			if (line.text.startsWith("new file mode ")) added = true;
			if (line.text === "--- /dev/null") {
				paths = { ...paths, oldPath: "/dev/null" };
				added = true;
			}
			if (line.text.startsWith("Binary files /dev/null and ")) {
				paths = { ...paths, oldPath: "/dev/null" };
				added = true;
			}
			if (line.text === "+++ /dev/null")
				paths = { ...paths, newPath: "/dev/null" };
			if (
				line.text.startsWith("Binary files ") ||
				line.text.startsWith("GIT binary patch")
			) {
				binary = true;
			}
			if (line.text.startsWith("@@@")) combined = true;
		}
		if (
			added &&
			paths.newPath &&
			paths.newPath !== "/dev/null" &&
			paths.oldPath === "/dev/null"
		) {
			addedPaths.push(paths.newPath);
		} else if (
			added &&
			paths.newPath &&
			paths.newPath !== "/dev/null" &&
			section.some((line) => line.text.startsWith("new file mode "))
		) {
			addedPaths.push(paths.newPath);
		}
		if (binary) {
			const path =
				paths.newPath === "/dev/null" ? paths.oldPath : paths.newPath;
			if (path) binaryPaths.push(path);
			continue;
		}
		if (combined) continue;
		const hunkStarts: number[] = [];
		for (let index = 1; index < section.length; index += 1) {
			if ((section[index]?.text ?? "").startsWith("@@")) hunkStarts.push(index);
		}
		for (let hunkIndex = 0; hunkIndex < hunkStarts.length; hunkIndex += 1) {
			const hunkStart = hunkStarts[hunkIndex] as number;
			const hunkEnd = hunkStarts[hunkIndex + 1] ?? section.length;
			const body = section.slice(hunkStart, hunkEnd);
			if (!body.some((line) => isChangedLine(line.text))) continue;
			const text = joinLines([headerLine, ...body]);
			const header = body[0]?.text ?? "";
			hunks.push({
				oldPath: paths.oldPath,
				newPath: paths.newPath,
				header,
				text,
				hash: hashText(text),
			});
		}
	}
	return { hunks, binaryPaths, addedPaths };
}

function literalExclude(path: string): string {
	return `:(exclude,literal,top)${path}`;
}

export function codeDiffPathspecs(excludedPaths: readonly string[]): string[] {
	const excluded = [...new Set(excludedPaths.filter(Boolean))].sort();
	// `:(literal,top).` and `:(top).` match a path named `.` and yield an empty
	// diff. `.` from the repository root includes every path; exclusions stay
	// literal so characters in those paths are not globs.
	return [".", ...excluded.map(literalExclude)];
}

export function codeDiffRetrievalCommand(input: {
	baseCommit: string;
	reviewedCommit: string;
	excludedPaths: readonly string[];
	/** Repository root. `-C` keeps `.` anchored when the shell cwd differs. */
	workdir?: string;
}): string {
	const args = [
		"git",
		...(input.workdir ? ["-C", input.workdir] : []),
		...CODE_DIFF_OPTIONS,
		`${input.baseCommit}..${input.reviewedCommit}`,
		"--",
		...codeDiffPathspecs(input.excludedPaths),
	];
	return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function gitOrThrow(
	git: CodeDiffGit,
	args: string[],
	options?: { exact?: boolean },
): Promise<string> {
	const result = await git.exec(args, options);
	if (result.exitCode !== 0) {
		throw new CodeDiffError(
			"CODE_DIFF_GIT_ERROR",
			result.stderr.trim() || `git ${args.join(" ")} failed`,
		);
	}
	return options?.exact ? result.stdout : result.stdout.trim();
}

export async function resolveCodeCommit(
	git: CodeDiffGit,
	commit: string,
): Promise<string> {
	try {
		const resolved = (
			await gitOrThrow(git, ["rev-parse", "--verify", `${commit}^{commit}`])
		).trim();
		if (!/^[0-9a-f]{40}$/u.test(resolved)) {
			throw new CodeDiffError(
				"CODE_DIFF_BAD_REF",
				`Commit '${commit}' did not resolve to a full SHA.`,
			);
		}
		return resolved;
	} catch (error) {
		if (error instanceof CodeDiffError && error.code === "CODE_DIFF_BAD_REF")
			throw error;
		throw new CodeDiffError(
			"CODE_DIFF_BAD_REF",
			`Commit '${commit}' is not an available git object.`,
		);
	}
}

export async function readHeadCommit(git: CodeDiffGit): Promise<string> {
	return resolveCodeCommit(git, "HEAD");
}

export async function commitParents(
	git: CodeDiffGit,
	commit: string,
): Promise<string[]> {
	const line = await gitOrThrow(git, [
		"rev-list",
		"--parents",
		"-n",
		"1",
		commit,
	]);
	const parts = line.trim().split(/\s+/u).filter(Boolean);
	if (parts[0] !== commit && !commit.startsWith(parts[0] ?? "")) {
		throw new CodeDiffError(
			"CODE_DIFF_BAD_REF",
			`Could not read parents of ${commit}.`,
		);
	}
	return parts.slice(1);
}

export async function isCodeAncestor(
	git: CodeDiffGit,
	maybeAncestor: string,
	commit: string,
): Promise<boolean> {
	if (maybeAncestor === commit) return true;
	const result = await git.exec([
		"merge-base",
		"--is-ancestor",
		maybeAncestor,
		commit,
	]);
	return result.exitCode === 0;
}

export async function assertCleanCodeWorktree(
	git: CodeDiffGit,
	excludedPaths: readonly string[],
): Promise<void> {
	const status = await git.exec(["status", "--porcelain"], { exact: true });
	if (status.exitCode !== 0) {
		throw new CodeDiffError(
			"CODE_DIFF_GIT_ERROR",
			status.stderr.trim() || "git status --porcelain failed",
		);
	}
	const dirty = status.stdout
		.split("\n")
		.filter((line) => line.length > 0 && line !== "\r")
		.map(porcelainPath)
		.filter((path) => path && !isExcludedPath(path, excludedPaths));
	if (dirty.length > 0) {
		throw new CodeDiffError(
			"CODE_DIFF_DIRTY",
			`The worktree has uncommitted code changes: ${dirty.join(", ")}.`,
		);
	}
}

function porcelainPath(line: string): string {
	const body = line.length >= 3 ? line.slice(3) : line;
	const rename = body.split(" -> ");
	return (rename.at(-1) ?? body).trim();
}

export function isExcludedPath(
	path: string,
	excludedPaths: readonly string[],
): boolean {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	return excludedPaths.some((excluded) => {
		const prefix = excluded.replaceAll("\\", "/").replace(/\/$/u, "");
		return normalized === prefix || normalized.startsWith(`${prefix}/`);
	});
}

export async function changedCodePaths(
	git: CodeDiffGit,
	from: string,
	to: string,
	excludedPaths: readonly string[],
): Promise<string[]> {
	if (from === to) return [];
	const names = await gitOrThrow(git, [
		"-c",
		"core.quotePath=false",
		"diff",
		"--name-status",
		"--find-renames=50%",
		`${from}..${to}`,
		"--",
		...codeDiffPathspecs(excludedPaths),
	]);
	const paths: string[] = [];
	for (const line of names.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const path = parts.at(-1);
		if (path) paths.push(path);
	}
	return paths;
}

export async function buildCodeDiff(input: {
	git: CodeDiffGit;
	baseCommit: string;
	reviewedCommit: string;
	excludedPaths: readonly string[];
}): Promise<CodeDiffContext> {
	const baseCommit = await resolveCodeCommit(input.git, input.baseCommit);
	const reviewedCommit = await resolveCodeCommit(
		input.git,
		input.reviewedCommit,
	);
	if (!(await isCodeAncestor(input.git, baseCommit, reviewedCommit))) {
		throw new CodeDiffError(
			"CODE_DIFF_NOT_ANCESTOR",
			`Review base ${baseCommit} is not an ancestor of ${reviewedCommit}.`,
		);
	}
	const excludedPaths = [
		...new Set(input.excludedPaths.filter(Boolean)),
	].sort();
	const patch = await gitOrThrow(
		input.git,
		[
			...CODE_DIFF_OPTIONS,
			`${baseCommit}..${reviewedCommit}`,
			"--",
			...codeDiffPathspecs(excludedPaths),
		],
		{ exact: true },
	);
	const parsed = parseCodePatch(patch);
	return {
		baseCommit,
		reviewedCommit,
		patch,
		patchHash: hashText(patch),
		excludedPaths,
		hunks: parsed.hunks,
		binaryPaths: parsed.binaryPaths,
	};
}

export async function assertNoInterveningCode(input: {
	git: CodeDiffGit;
	reviewedCommit: string;
	headCommit: string;
	excludedPaths: readonly string[];
}): Promise<void> {
	if (input.reviewedCommit === input.headCommit) return;
	if (
		!(await isCodeAncestor(input.git, input.reviewedCommit, input.headCommit))
	) {
		throw new CodeDiffError(
			"CODE_DIFF_STALE",
			`Reviewed commit ${input.reviewedCommit} is not an ancestor of HEAD. Prepare a new review context.`,
		);
	}
	const paths = await changedCodePaths(
		input.git,
		input.reviewedCommit,
		input.headCommit,
		input.excludedPaths,
	);
	if (paths.length > 0) {
		throw new CodeDiffError(
			"CODE_DIFF_INTERVENING",
			`Code changed after the reviewed commit (${paths.join(", ")}). Prepare a new review context.`,
		);
	}
}

function uniqueCommit(
	reference: string,
	commits: readonly string[],
): string | null {
	const matches = commits.filter((commit) => commit.startsWith(reference));
	return matches.length === 1 ? (matches[0] as string) : null;
}

function loosenWhitespace(value: string): string {
	return value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""))
		.join("\n");
}

function stripFinalTerminator(value: string): string {
	if (value.endsWith("\r\n")) return value.slice(0, -2);
	if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
	return value;
}

/**
 * Match a cited hunk to the stored form. Drop extended-header lines between
 * `diff --git` and the first `@@`, and ignore one missing final newline.
 * Line whitespace and every other terminator stay significant.
 */
function canonicalizeCitedHunk(cited: string): string {
	const lines = splitLinesKeepEol(cited);
	const headerAt = lines.findIndex((line) =>
		line.text.startsWith("diff --git "),
	);
	let kept = lines;
	if (headerAt >= 0) {
		const hunkAt = lines.findIndex(
			(line, index) => index > headerAt && line.text.startsWith("@@"),
		);
		if (hunkAt > headerAt + 1) {
			kept = [...lines.slice(0, headerAt + 1), ...lines.slice(hunkAt)];
		}
	}
	return stripFinalTerminator(joinLines(kept));
}

export function validateCodeHunkEvidence(
	evidence: IntroducedByPlanHunk,
	context: CodeDiffContext,
): CodeHunkValidation {
	if (
		!evidence.commitRange?.trim() ||
		!evidence.diffHunk?.trim() ||
		!evidence.explanation?.trim()
	) {
		return {
			valid: false,
			code: "CODE_HUNK_EVIDENCE_INCOMPLETE",
			message:
				"Ordinary code evidence requires a commit range, a complete hunk, and a causal explanation.",
		};
	}
	const range = /^([^\s.]+)\.\.([^\s.]+)$/u.exec(evidence.commitRange.trim());
	const commits = [context.baseCommit, context.reviewedCommit];
	const start = range ? uniqueCommit(range[1] as string, commits) : null;
	const end = range ? uniqueCommit(range[2] as string, commits) : null;
	if (
		!start ||
		start !== context.baseCommit ||
		!end ||
		end !== context.reviewedCommit
	) {
		return {
			valid: false,
			code: "CODE_RANGE_MISMATCH",
			message: `Introducing range must be exactly ${context.baseCommit}..${context.reviewedCommit}. A later review-only commit is not an equivalent end.`,
		};
	}
	const cited = evidence.diffHunk;
	const citedCanonical = canonicalizeCitedHunk(cited);
	if (
		cited.includes("\nBinary files ") ||
		cited.startsWith("Binary files ") ||
		cited.includes("GIT binary patch")
	) {
		return {
			valid: false,
			code: "CODE_HUNK_BINARY",
			message:
				"Binary changes do not supply text hunk evidence. Initial findings or a human safety escalation can still name the file.",
		};
	}
	if (splitLinesKeepEol(cited).some((line) => line.text.startsWith("@@@"))) {
		return {
			valid: false,
			code: "CODE_HUNK_COMBINED",
			message: "Combined merge hunks cannot identify an ordinary code change.",
		};
	}
	if (!splitLinesKeepEol(cited).some((line) => isChangedLine(line.text))) {
		return {
			valid: false,
			code: "CODE_HUNK_CONTEXT_ONLY",
			message: "The cited hunk has no added or removed lines.",
		};
	}
	const match = context.hunks.find(
		(hunk) => canonicalizeCitedHunk(hunk.text) === citedCanonical,
	);
	if (match) return { valid: true, hunkHash: match.hash };
	const citedBody = hunkBody(citedCanonical);
	const sameBody = context.hunks.filter(
		(hunk) => hunkBody(canonicalizeCitedHunk(hunk.text)) === citedBody,
	);
	if (sameBody.length > 0) {
		return {
			valid: false,
			code: "CODE_HUNK_WRONG_FILE",
			message: `The cited hunk body matches ${sameBody.map((hunk) => hunk.newPath).join(", ")} but the diff --git file header does not.`,
		};
	}
	const loosened = loosenWhitespace(citedCanonical);
	if (
		context.hunks.some(
			(hunk) => loosenWhitespace(canonicalizeCitedHunk(hunk.text)) === loosened,
		)
	) {
		return {
			valid: false,
			code: "CODE_HUNK_WHITESPACE",
			message:
				"The cited hunk changes source whitespace. Code evidence must preserve the exact hunk bytes.",
		};
	}
	return {
		valid: false,
		code: "CODE_HUNK_NOT_FOUND",
		message:
			"The cited complete file-qualified hunk is not in the prepared code diff.",
	};
}

/**
 * Locate each stored hunk's `@@` header inside its own file section.
 * Identical headers in later files must not resolve to the first file.
 */
function hunkHeaderPositions(
	lines: readonly KeptLine[],
	hunks: readonly ImplementationReviewHunk[],
): number[] {
	const positions: number[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const fileLine = splitLinesKeepEol(hunk.text)[0]?.text ?? "";
		let fileAt = -1;
		for (let index = cursor; index < lines.length; index += 1) {
			if (lines[index]?.text === fileLine) {
				fileAt = index;
				break;
			}
		}
		const searchFrom = fileAt >= 0 ? fileAt + 1 : cursor;
		let headerAt = -1;
		for (let index = searchFrom; index < lines.length; index += 1) {
			const text = lines[index]?.text ?? "";
			if (fileAt < 0 && text.startsWith("diff --git ")) break;
			if (text === hunk.header) {
				headerAt = index;
				break;
			}
		}
		positions.push(headerAt);
		if (headerAt >= 0) cursor = headerAt + 1;
	}
	return positions;
}

export function formatCodeReviewDiff(
	input: {
		contextId: string;
		diff: CodeDiffContext;
		workdir?: string;
	},
	maxLines = 200,
): string {
	const lines = input.diff.patch ? splitLinesKeepEol(input.diff.patch) : [];
	const shown = lines.slice(0, maxLines);
	const truncated = lines.length > maxLines;
	const positions = hunkHeaderPositions(lines, input.diff.hunks);
	const omitted = input.diff.hunks.flatMap((hunk, index) => {
		const position = positions[index] ?? -1;
		if (position < 0) return [];
		const hunkLength = splitLinesKeepEol(hunk.text).length;
		return position >= maxLines || position + hunkLength > maxLines
			? [`${hunk.oldPath} -> ${hunk.newPath}: ${hunk.header}`]
			: [];
	});
	const range = `${input.diff.baseCommit}..${input.diff.reviewedCommit}`;
	const body = input.diff.patch
		? `\`\`\`diff\n${joinLines(shown)}\n\`\`\``
		: "(no code changes in the reviewed range)";
	const binary =
		input.diff.binaryPaths.length > 0
			? `\nBinary files with no text hunk:\n${input.diff.binaryPaths.map((path) => `- \`${path}\``).join("\n")}\n`
			: "";
	return (
		"\n## Implementation Diff\n\n" +
		`Review context: \`${input.contextId}\`\n\n` +
		`Commit range: \`${range}\`\n\n${body}\n` +
		(truncated
			? `\n... (truncated, ${lines.length - maxLines} more lines)\n\nOmitted hunk headers:\n${omitted.map((header) => `- \`${header}\``).join("\n") || "- (none)"}\n`
			: "") +
		binary +
		`\nRetrieve the complete diff with:\n\n\`${codeDiffRetrievalCommand({
			baseCommit: input.diff.baseCommit,
			reviewedCommit: input.diff.reviewedCommit,
			excludedPaths: input.diff.excludedPaths,
			...(input.workdir ? { workdir: input.workdir } : {}),
		})}\`\n\n` +
		"Pass this review context id back as `--review-context` when recording the verdict. " +
		"Ordinary continued blockers need one exact file-qualified hunk from this range: " +
		"the `diff --git` line plus the complete `@@` hunk, including every added and removed line. " +
		"Extended headers between them (`index`, `---`, `+++`, mode, similarity, and rename lines) may be copied from this diff or omitted. " +
		"A missing final newline is accepted. Every other character, including spaces and line endings, must match.\n"
	);
}

export function formatCodeReviewDiffFailure(error: CodeDiffError): string {
	return (
		"\n## Implementation Diff\n\n" +
		`The exact code diff could not be prepared (\`${error.code}\`): ${error.message}\n`
	);
}

export interface CodeClosureFinding {
	id: string;
}

export interface CodeClosureDecision {
	decisionId: string;
	findingIds: readonly string[];
	evidence?: readonly string[];
}

export interface CodeClosureResult {
	diagnostics: ImplementationDiagnostic[];
	forcesHuman: boolean;
}

function closureDiagnostic(
	code: ImplementationDiagnostic["code"],
	message: string,
	severity: "error" | "info" = "error",
	itemId?: string,
): ImplementationDiagnostic {
	return { code, severity, message, ...(itemId ? { itemId } : {}) };
}

function isCriticalLate(item: VerdictItem): boolean {
	return item.lateDiscovery === "critical_safety";
}

export function validateCodeReviewClosure(input: {
	verdict: ReviewerVerdict;
	reviewRound: number;
	priorFindings?: readonly CodeClosureFinding[];
	decisions?: readonly CodeClosureDecision[];
	/** Null means a continued review was required to name a prepared context. */
	codeContext?: CodeDiffContext | null;
}): CodeClosureResult {
	const diagnostics: CodeClosureResult["diagnostics"] = [];
	let forcesHuman = false;
	const prior = input.priorFindings ?? [];
	const required = new Set(prior.map((finding) => finding.id));
	const continued = input.reviewRound > 1 || prior.length > 0;
	if (continued) {
		const seen = new Set<string>();
		for (const outcome of input.verdict.priorFindings ?? []) {
			if (!required.has(outcome.id)) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_FINDING_UNKNOWN",
						`Prior-finding outcome '${outcome.id}' is not open in this code review.`,
						"error",
						outcome.id,
					),
				);
			}
			if (seen.has(outcome.id)) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_FINDING_DUPLICATE",
						`Prior finding '${outcome.id}' has more than one outcome.`,
						"error",
						outcome.id,
					),
				);
			}
			seen.add(outcome.id);
		}
		for (const finding of prior) {
			const outcome = input.verdict.priorFindings?.find(
				(entry) => entry.id === finding.id,
			);
			if (!outcome) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_FINDING_OMITTED",
						`Closure review omitted prior finding '${finding.id}'.`,
						"error",
						finding.id,
					),
				);
				continue;
			}
			const count = input.verdict.items.filter(
				(item) => item.id === finding.id,
			).length;
			if (
				(outcome.status === "partially_addressed" ||
					outcome.status === "still_open") &&
				count !== 1
			) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_FINDING_ITEM_MISSING",
						`Prior finding '${finding.id}' is ${outcome.status} and must remain exactly once in items.`,
						"error",
						finding.id,
					),
				);
			}
			if (outcome.status === "addressed" && count !== 0) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_FINDING_ITEM_UNEXPECTED",
						`Addressed prior finding '${finding.id}' must not remain in items.`,
						"error",
						finding.id,
					),
				);
			}
		}
	}

	for (const item of input.verdict.items) {
		if (required.has(item.id) && !item.priorDecisionId) continue;
		const ordinary =
			item.scopeClass === "implementation_defect" && !isCriticalLate(item);
		const reRaise = Boolean(item.priorDecisionId);
		if (isCriticalLate(item)) {
			forcesHuman = true;
			diagnostics.push(
				closureDiagnostic(
					"CRITICAL_LATE_REQUIRES_HUMAN",
					`Finding '${item.id}' is a critical late issue and routes to a human without a text hunk.`,
					"info",
					item.id,
				),
			);
			if (!item.lateDiscoveryEvidence?.trim()) {
				diagnostics.push(
					closureDiagnostic(
						"CODE_HUNK_EVIDENCE_INCOMPLETE",
						`Finding '${item.id}' requires lateDiscoveryEvidence for a critical safety escalation.`,
						"error",
						item.id,
					),
				);
			}
		}
		if (reRaise) {
			const decision = input.decisions?.find(
				(entry) => entry.decisionId === item.priorDecisionId,
			);
			if (!decision?.findingIds.includes(item.id)) {
				diagnostics.push(
					closureDiagnostic(
						"PRIOR_DECISION_MISMATCH",
						`Finding '${item.id}' does not match deferred decision '${item.priorDecisionId}'.`,
						"error",
						item.id,
					),
				);
			} else {
				const evidence = item.newEvidence?.trim() ?? "";
				const seen = decision.evidence ?? [];
				if (!evidence || seen.includes(evidence)) {
					diagnostics.push(
						closureDiagnostic(
							"PRIOR_DECISION_NEW_EVIDENCE_REQUIRED",
							`Finding '${item.id}' needs materially new evidence beyond decision '${decision.decisionId}'.`,
							"error",
							item.id,
						),
					);
				}
			}
		}
		if (!ordinary && !reRaise) continue;
		if (!continued && !item.introducedBy) continue;
		if (input.codeContext === null || input.codeContext === undefined) {
			if (continued && (ordinary || reRaise)) {
				diagnostics.push(
					closureDiagnostic(
						"CODE_DIFF_CONTEXT_MISSING",
						`Finding '${item.id}' cannot become an ordinary blocker without the prepared code-review context.`,
						"error",
						item.id,
					),
				);
			}
			continue;
		}
		if (!item.introducedBy) {
			diagnostics.push(
				closureDiagnostic(
					"NEW_FINDING_EVIDENCE_REQUIRED",
					`Finding '${item.id}' needs an exact introducing code hunk and a causal explanation.`,
					"error",
					item.id,
				),
			);
			continue;
		}
		const checked = validateCodeHunkEvidence(
			item.introducedBy,
			input.codeContext,
		);
		if (!checked.valid) {
			diagnostics.push(
				closureDiagnostic(checked.code, checked.message, "error", item.id),
			);
		}
	}
	return { diagnostics, forcesHuman };
}
