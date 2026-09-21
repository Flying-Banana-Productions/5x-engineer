/**
 * Git-native plan progress resolution (`207` §2.4).
 *
 * Git I/O stays in `git.ts`; this module ranks candidate refs and reads
 * plan markdown from the winning commit (or mapped worktree working copy).
 *
 * Spike (2026-09-03): a 20-plan × 3-remote fixture with the naive
 * `git log -1` × `merge-base --is-ancestor` loop took 1551ms
 * (last-touching 1120ms, pairwise ancestor 430ms / 40 calls). That exceeds
 * the ~500ms budget, so this module batches `for-each-ref` + one
 * `rev-list --parents` topology query + one `git log --name-only`.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseRunJson } from "../control-plane/record-layout.js";
import {
	fetchFiveXBranches,
	gitDeletedPaths,
	gitLogLastTouching,
	gitLogNameOnly,
	gitLsTreePaths,
	gitRevListParents,
	gitShowFile,
	listFiveXRefs,
	listRefTips,
	listRemotes,
	revParseCommit,
} from "../git.js";
import { parsePlan } from "../parsers/plan.js";
import { relativePathUnder } from "../paths.js";

export type ProgressSourceKind =
	| "worktree"
	| "branch" // local 5x/<slug> or plans.branch
	| "remote" // origin/5x/<slug>
	| "HEAD"
	| "diverged"
	| "local-index" // no record on any ref; SQLite only
	| "backfilled"; // record present but provenance is backfilled-only / no branch

export interface ProgressSource {
	kind: ProgressSourceKind;
	label: string; // "worktree" | "5x/<slug>" | "origin/5x/<slug>" | "HEAD" | "diverged"
	ref?: string;
	commit?: string;
	age_seconds?: number; // remote-tracking tip vs now
}

export type PlanProgressState = "present" | "deleted" | "missing" | "diverged";

export interface ResolvedPlanProgress {
	state: PlanProgressState;
	source: ProgressSource;
	diverged_sources?: Array<ProgressSource & { plan_state: PlanProgressState }>;
	markdown: string | null;
	planPath: string;
	commit: string | null;
}

export type LastTouchingCache = Map<string, string | null>;

interface NamedTip {
	source: ProgressSource;
	sha: string;
	worktreePath?: string;
}

export interface ProgressSession {
	workdir: string;
	recordsRelPath: string;
	nowMs: number;
	tips: NamedTip[];
	parents: Map<string, string[]>;
	logEntries: Array<{ commit: string; files: string[] }>;
	/** Paths covered by a successful batch, including negative lookups. */
	logPaths: string[];
	discoveredPlanRels: string[];
	/** Batched working-copy removals, keyed by checkout root. */
	checkoutDeletions: Map<string, Set<string>>;
	/** In-process `(refSha, pathKey) → lastTouching` for one `plan list` invocation. */
	cache: LastTouchingCache;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function posixJoin(...parts: string[]): string {
	return parts
		.map((p) => toPosix(p).replace(/^\/+|\/+$/g, ""))
		.filter(Boolean)
		.join("/");
}

function repoRelFromAbsOrRel(path: string, workdir: string): string | null {
	const posix = toPosix(path);
	if (!isAbsolute(path) && !path.startsWith("/")) {
		return posix.replace(/^\.\//, "");
	}
	const rel = relativePathUnder(path, workdir);
	if (rel === null) return null;
	return toPosix(rel);
}

function checkoutAbs(workdir: string, rel: string): string {
	return join(workdir, ...rel.split("/").filter(Boolean));
}

export function parseRevListParents(stdout: string): Map<string, string[]> {
	const parents = new Map<string, string[]>();
	if (!stdout) return parents;
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [sha, ...pts] = line.split(" ");
		if (!sha) continue;
		parents.set(sha, pts.filter(Boolean));
	}
	return parents;
}

export function parseLogNameOnly(
	stdout: string,
): Array<{ commit: string; files: string[] }> {
	const entries: Array<{ commit: string; files: string[] }> = [];
	let current: { commit: string; files: string[] } | null = null;
	for (const raw of stdout.split("\n")) {
		if (/^[0-9a-f]{40,}$/i.test(raw)) {
			if (current) entries.push(current);
			current = { commit: raw, files: [] };
			continue;
		}
		// Git separates the commit header from its filenames with a blank line.
		if (raw === "") continue;
		if (current) current.files.push(toPosix(raw));
	}
	if (current) entries.push(current);
	return entries;
}

/** True when `maybeAncestor` is A and we can walk parents from `commit` to A (A≠commit). */
export function isAncestorInGraph(
	parents: Map<string, string[]>,
	maybeAncestor: string,
	commit: string,
): boolean {
	if (maybeAncestor === commit) return false;
	const seen = new Set<string>();
	const stack = [commit];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (!cur || seen.has(cur)) continue;
		seen.add(cur);
		const pts = parents.get(cur);
		if (!pts) continue;
		for (const p of pts) {
			if (p === maybeAncestor) return true;
			stack.push(p);
		}
	}
	return false;
}

function reachableFrom(
	parents: Map<string, string[]>,
	tip: string,
): Set<string> {
	const seen = new Set<string>();
	const stack = [tip];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (!cur || seen.has(cur)) continue;
		seen.add(cur);
		for (const p of parents.get(cur) ?? []) stack.push(p);
	}
	return seen;
}

function lastTouchingFromLog(
	logEntries: Array<{ commit: string; files: string[] }>,
	reachable: Set<string>,
	touchPaths: string[],
): string | null {
	const prefixes = touchPaths.map((p) => (p.endsWith("/") ? p : `${p}/`));
	for (const entry of logEntries) {
		if (!reachable.has(entry.commit)) continue;
		const hit = entry.files.some((f) =>
			touchPaths.some((p, i) => f === p || f.startsWith(prefixes[i] as string)),
		);
		if (hit) return entry.commit;
	}
	return null;
}

function shortRef(refname: string): string {
	if (refname.startsWith("refs/heads/")) {
		return refname.slice("refs/heads/".length);
	}
	if (refname.startsWith("refs/remotes/")) {
		return refname.slice("refs/remotes/".length);
	}
	return refname;
}

function sourceForRefname(
	refname: string,
	plansBranch?: string | null,
): ProgressSource {
	const label = shortRef(refname);
	if (refname.startsWith("refs/remotes/")) {
		return { kind: "remote", label, ref: label };
	}
	if (refname.startsWith("refs/heads/")) {
		return { kind: "branch", label, ref: label };
	}
	if (label === "HEAD") {
		return { kind: "HEAD", label: "HEAD", ref: "HEAD" };
	}
	if (plansBranch && (label === plansBranch || refname === plansBranch)) {
		return { kind: "branch", label: plansBranch, ref: plansBranch };
	}
	if (label.startsWith("5x/")) {
		return { kind: "branch", label, ref: label };
	}
	if (label.includes("/5x/")) {
		return { kind: "remote", label, ref: label };
	}
	return { kind: "branch", label, ref: label };
}

function ageSeconds(
	committerUnix: number | null | undefined,
	nowMs: number,
): number | undefined {
	if (committerUnix == null) return undefined;
	const age = Math.floor(nowMs / 1000 - committerUnix);
	return age >= 0 ? age : 0;
}

function touchesPlan(rel: string, plansRel: string, skip: string[]): boolean {
	const posix = toPosix(rel);
	if (!posix.toLowerCase().endsWith(".md")) return false;
	const root = toPosix(plansRel).replace(/\/$/, "");
	if (root && posix !== root && !posix.startsWith(`${root}/`)) return false;
	for (const prefix of skip) {
		const p = toPosix(prefix).replace(/\/$/, "");
		if (!p) continue;
		if (posix === p || posix.startsWith(`${p}/`)) return false;
	}
	return true;
}

async function collectCandidateTips(opts: {
	workdir: string;
	planSlug?: string;
	plansBranch?: string | null;
	allRefs?: boolean;
	worktreeHeads?: Array<{ path: string; sha: string; unix: number | null }>;
	nowMs: number;
}): Promise<NamedTip[]> {
	const tips: NamedTip[] = [];
	const seenRef = new Set<string>();
	const add = (
		source: ProgressSource,
		sha: string,
		unix?: number | null,
		worktreePath?: string,
	) => {
		const key =
			source.kind === "worktree"
				? `worktree:${worktreePath ?? sha}`
				: (source.ref ?? source.label);
		if (seenRef.has(key)) return;
		seenRef.add(key);
		const src = { ...source };
		if (src.kind === "remote") {
			const age = ageSeconds(unix, opts.nowMs);
			if (age != null) src.age_seconds = age;
		}
		tips.push({
			source: src,
			sha,
			...(worktreePath ? { worktreePath } : {}),
		});
	};

	for (const wt of opts.worktreeHeads ?? []) {
		add(
			{
				kind: "worktree",
				label: "worktree",
				ref: "HEAD",
				commit: wt.sha,
			},
			wt.sha,
			wt.unix,
			wt.path,
		);
	}

	const fiveX = await listFiveXRefs(opts.workdir);
	// A different plan branch can carry a later edit or deletion. Use the same
	// candidates for individual lookups as for the shared plan-list session.
	const localRefs = fiveX.local;
	const remoteRefs = fiveX.remote;

	const fiveXTips = await listRefTips(opts.workdir, [
		"refs/heads/5x/*",
		"refs/remotes/*/5x/*",
	]);
	const unixByShort = new Map<string, number | null>();
	for (const t of fiveXTips) {
		unixByShort.set(shortRef(t.refname), t.committerUnix);
	}

	for (const ref of localRefs) {
		const sha =
			fiveXTips.find((t) => shortRef(t.refname) === ref)?.sha ??
			(await revParseCommit(opts.workdir, ref));
		if (!sha) continue;
		add({ kind: "branch", label: ref, ref }, sha, unixByShort.get(ref));
	}
	for (const rem of remoteRefs) {
		const sha =
			fiveXTips.find((t) => shortRef(t.refname) === rem.ref)?.sha ??
			(await revParseCommit(opts.workdir, rem.ref));
		if (!sha) continue;
		add(
			{ kind: "remote", label: rem.ref, ref: rem.ref },
			sha,
			unixByShort.get(rem.ref),
		);
	}

	if (opts.plansBranch) {
		const sha = await revParseCommit(opts.workdir, opts.plansBranch);
		if (sha) {
			add(
				{ kind: "branch", label: opts.plansBranch, ref: opts.plansBranch },
				sha,
			);
		}
	}

	const headSha = await revParseCommit(opts.workdir, "HEAD");
	if (headSha) {
		add({ kind: "HEAD", label: "HEAD", ref: "HEAD" }, headSha);
	}

	if (opts.allRefs) {
		const all = await listRefTips(opts.workdir, ["refs/heads", "refs/remotes"]);
		for (const t of all) {
			const src = sourceForRefname(t.refname, opts.plansBranch);
			add(src, t.sha, t.committerUnix);
		}
	}

	return tips;
}

export async function prepareProgressSession(opts: {
	workdir: string;
	recordsRelPath: string;
	plansRelPath?: string;
	skipRelPrefixes?: string[];
	planRepoRels?: string[];
	planSlug?: string;
	plansBranch?: string | null;
	allRefs?: boolean;
	worktreePaths?: string[];
	nowMs?: number;
	cache?: LastTouchingCache;
}): Promise<ProgressSession> {
	const nowMs = opts.nowMs ?? Date.now();
	const recordsRelPath = toPosix(opts.recordsRelPath).replace(/\/$/, "");
	const worktreeHeads: Array<{
		path: string;
		sha: string;
		unix: number | null;
	}> = [];
	for (const wt of opts.worktreePaths ?? []) {
		const sha = await revParseCommit(wt, "HEAD");
		if (!sha) continue;
		worktreeHeads.push({ path: wt, sha, unix: null });
	}

	const tips = await collectCandidateTips({
		workdir: opts.workdir,
		planSlug: opts.planSlug,
		plansBranch: opts.plansBranch,
		allRefs: opts.allRefs,
		worktreeHeads,
		nowMs,
	});

	const uniqueShas = [...new Set(tips.map((t) => t.sha))];
	const parents = parseRevListParents(
		uniqueShas.length > 0
			? await gitRevListParents(opts.workdir, uniqueShas)
			: "",
	);

	const skip = (opts.skipRelPrefixes ?? []).map((p) => toPosix(p));
	const discovered = new Set((opts.planRepoRels ?? []).map(toPosix));
	const plansRel = opts.plansRelPath ? toPosix(opts.plansRelPath) : "";
	if (plansRel) {
		const treeShas = [...new Set(tips.map((t) => t.sha))];
		for (const sha of treeShas) {
			const files = await gitLsTreePaths(opts.workdir, sha, plansRel);
			for (const f of files) {
				if (touchesPlan(f, plansRel, skip)) discovered.add(toPosix(f));
			}
		}
	}

	const logPaths = [
		...discovered,
		...(opts.planRepoRels ?? []).map(toPosix),
		recordsRelPath,
	].filter(Boolean);
	const uniqueLogPaths = [...new Set(logPaths)];
	const logOutput =
		uniqueShas.length > 0 && uniqueLogPaths.length > 0
			? await gitLogNameOnly(opts.workdir, uniqueShas, uniqueLogPaths)
			: null;
	const logEntries = parseLogNameOnly(logOutput ?? "");
	const checkoutDeletions = new Map<string, Set<string>>();
	for (const tip of tips) {
		const checkout =
			tip.source.kind === "HEAD" ? opts.workdir : tip.worktreePath;
		if (!checkout || checkoutDeletions.has(checkout)) continue;
		checkoutDeletions.set(checkout, new Set(await gitDeletedPaths(checkout)));
	}

	return {
		workdir: opts.workdir,
		recordsRelPath,
		nowMs,
		tips,
		parents,
		logEntries,
		logPaths: logOutput === null ? [] : uniqueLogPaths,
		discoveredPlanRels: [...discovered].sort(),
		checkoutDeletions,
		cache: opts.cache ?? new Map(),
	};
}

interface RankedCandidate {
	source: ProgressSource;
	commit: string;
	tipSha: string;
	/** Explicit working-copy removal; don't read the still-present HEAD blob. */
	deleted?: boolean;
}

async function lastTouching(
	session: ProgressSession,
	sha: string,
	touchPaths: string[],
): Promise<string | null> {
	const cacheKey = `${sha}\0${touchPaths.join("\0")}`;
	let last = session.cache.get(cacheKey);
	if (last !== undefined) return last;
	const reachable = reachableFrom(session.parents, sha);
	last = lastTouchingFromLog(session.logEntries, reachable, touchPaths);
	const covered =
		session.parents.has(sha) &&
		touchPaths.every((path) =>
			session.logPaths.some(
				(root) => path === root || path.startsWith(`${root}/`),
			),
		);
	if (!last && !covered) {
		last = await gitLogLastTouching(session.workdir, sha, touchPaths);
	}
	session.cache.set(cacheKey, last);
	return last;
}

/** Tie-break only equivalent progress commits, never newer vs older progress. */
function sourcePriority(
	source: ProgressSource,
	planSlug: string,
	plansBranch?: string | null,
): number {
	if (source.kind === "worktree") return 0;
	if (source.kind === "HEAD") return 1;
	if (plansBranch && shortRef(source.ref ?? "") === shortRef(plansBranch)) {
		return 2;
	}
	if (source.kind === "branch" && source.label === `5x/${planSlug}`) return 3;
	if (source.kind === "remote" && source.label.endsWith(`/5x/${planSlug}`)) {
		return 4;
	}
	return 5;
}

async function rankCandidates(
	session: ProgressSession,
	touchPaths: string[],
	planSlug: string,
	plansBranch?: string | null,
	checkoutCandidates: RankedCandidate[] = [],
): Promise<RankedCandidate[]> {
	const ranked = [...checkoutCandidates];

	for (const tip of session.tips) {
		if (tip.source.kind === "worktree") continue;
		const last = await lastTouching(session, tip.sha, touchPaths);
		if (!last) continue;
		const source: ProgressSource = {
			...tip.source,
			commit: last,
		};
		ranked.push({ source, commit: last, tipSha: tip.sha });
	}

	ranked.sort((a, b) => {
		return (
			sourcePriority(a.source, planSlug, plansBranch) -
				sourcePriority(b.source, planSlug, plansBranch) ||
			a.source.label.localeCompare(b.source.label)
		);
	});
	const byCommit = new Map<string, RankedCandidate>();
	for (const cand of ranked) {
		if (!byCommit.has(cand.commit)) byCommit.set(cand.commit, cand);
	}
	const unique = [...byCommit.values()];
	return unique.filter((a) => {
		for (const b of unique) {
			if (a.commit === b.commit) continue;
			if (isAncestorInGraph(session.parents, a.commit, b.commit)) return false;
		}
		return true;
	});
}

function phaseCompletionPct(markdown: string): number {
	const parsed = parsePlan(markdown);
	const total = parsed.phases.length;
	if (total === 0) return 0;
	const done = parsed.phases.filter((p) => p.isComplete).length;
	return Math.round((done / total) * 100);
}

async function maybeBackfilledSource(opts: {
	workdir: string;
	planSlug: string;
	recordsRelPath: string;
	source: ProgressSource;
	commit: string | null;
}): Promise<ProgressSource> {
	if (opts.source.kind !== "HEAD" || !opts.commit) return opts.source;
	const fiveX = await listFiveXRefs(opts.workdir);
	const localName = `5x/${opts.planSlug}`;
	const hasConv =
		fiveX.local.includes(localName) ||
		fiveX.remote.some(
			(r) => r.ref.endsWith(`/${localName}`) || r.ref === localName,
		);
	if (hasConv) return opts.source;
	const prefix = posixJoin(opts.recordsRelPath, opts.planSlug);
	const paths = await gitLsTreePaths(opts.workdir, opts.commit, prefix);
	for (const rel of paths) {
		if (!rel.endsWith("/run.json") && rel !== `${prefix}/run.json`) continue;
		const text = await gitShowFile(opts.workdir, opts.commit, rel);
		if (text == null) continue;
		try {
			const summary = parseRunJson(text);
			if (summary.backfilled === true) {
				return {
					kind: "backfilled",
					label: "backfilled",
					ref: opts.source.ref,
					commit: opts.commit,
				};
			}
		} catch {
			/* ignore */
		}
	}
	return opts.source;
}

async function readMarkdownAtCommit(
	workdir: string,
	commit: string,
	relPlanPath: string,
): Promise<string | null> {
	return gitShowFile(workdir, commit, relPlanPath, { strict: true });
}

function readDiskMarkdown(opts: {
	workdir: string;
	planPath: string;
	relPlanPath: string | null;
	worktreePath?: string | null;
}): { markdown: string | null; kind: "worktree" | "HEAD" } {
	if (opts.worktreePath && opts.relPlanPath) {
		const wtFile = checkoutAbs(opts.worktreePath, opts.relPlanPath);
		if (existsSync(wtFile)) {
			return { markdown: readFileSync(wtFile, "utf-8"), kind: "worktree" };
		}
	}
	if (existsSync(opts.planPath)) {
		return { markdown: readFileSync(opts.planPath, "utf-8"), kind: "HEAD" };
	}
	if (opts.relPlanPath) {
		const checkout = checkoutAbs(opts.workdir, opts.relPlanPath);
		if (existsSync(checkout)) {
			return { markdown: readFileSync(checkout, "utf-8"), kind: "HEAD" };
		}
	}
	return { markdown: null, kind: "HEAD" };
}

export async function resolvePlanProgress(opts: {
	workdir: string;
	planPath: string;
	planSlug: string;
	recordsRelPath: string;
	worktreePath?: string | null;
	plansBranch?: string | null;
	allRefs?: boolean;
	nowMs?: number;
	session?: ProgressSession;
	cache?: LastTouchingCache;
}): Promise<ResolvedPlanProgress> {
	const relPlanPath = repoRelFromAbsOrRel(opts.planPath, opts.workdir);
	const recordsRel = toPosix(opts.recordsRelPath).replace(/\/$/, "");
	const touchPaths = [
		...(relPlanPath ? [relPlanPath] : []),
		posixJoin(recordsRel, opts.planSlug),
	];

	const session =
		opts.session ??
		(await prepareProgressSession({
			workdir: opts.workdir,
			recordsRelPath: recordsRel,
			planRepoRels: relPlanPath ? [relPlanPath] : [],
			planSlug: opts.planSlug,
			plansBranch: opts.plansBranch,
			allRefs: opts.allRefs,
			worktreePaths: opts.worktreePath ? [opts.worktreePath] : [],
			nowMs: opts.nowMs,
			cache: opts.cache,
		}));

	const checkoutCandidates: RankedCandidate[] = [];
	if (relPlanPath) {
		for (const tip of session.tips) {
			const checkout =
				tip.source.kind === "HEAD" ? opts.workdir : tip.worktreePath;
			if (
				!checkout ||
				(checkout !== opts.workdir && checkout !== opts.worktreePath)
			)
				continue;
			if (!session.checkoutDeletions.get(checkout)?.has(relPlanPath)) continue;
			checkoutCandidates.push({
				source: { ...tip.source, commit: tip.sha },
				commit: tip.sha,
				tipSha: tip.sha,
				deleted: true,
			});
		}
	}
	if (opts.worktreePath && relPlanPath) {
		const wtFile = checkoutAbs(opts.worktreePath, relPlanPath);
		if (existsSync(wtFile)) {
			const wtTip = session.tips.find(
				(t) =>
					t.source.kind === "worktree" && t.worktreePath === opts.worktreePath,
			);
			const wtSha =
				wtTip?.sha ?? (await revParseCommit(opts.worktreePath, "HEAD"));
			if (!wtSha) {
				const disk = readDiskMarkdown({
					workdir: opts.workdir,
					planPath: opts.planPath,
					relPlanPath,
					worktreePath: opts.worktreePath,
				});
				return {
					state: disk.markdown === null ? "missing" : "present",
					source: {
						kind: "worktree",
						label: "worktree",
						ref: "HEAD",
					},
					markdown: disk.markdown,
					planPath: relPlanPath ?? opts.planPath,
					commit: null,
				};
			}
			const last = await lastTouching(session, wtSha, touchPaths);
			const commit = last ?? wtSha;
			checkoutCandidates.push({
				source: {
					kind: "worktree",
					label: "worktree",
					ref: "HEAD",
					commit,
				},
				commit,
				tipSha: wtSha,
			});
		}
	}

	const survivors = await rankCandidates(
		session,
		touchPaths,
		opts.planSlug,
		opts.plansBranch,
		checkoutCandidates,
	);

	if (survivors.length === 0) {
		const disk = readDiskMarkdown({
			workdir: opts.workdir,
			planPath: opts.planPath,
			relPlanPath,
			worktreePath: opts.worktreePath,
		});
		return {
			state: disk.markdown === null ? "missing" : "present",
			source: {
				kind: disk.kind,
				label: disk.kind === "worktree" ? "worktree" : "HEAD",
				ref: "HEAD",
			},
			markdown: disk.markdown,
			planPath: relPlanPath ?? opts.planPath,
			commit: null,
		};
	}

	// Keep deletion candidates until AFTER ancestry pruning. Otherwise a stale
	// pre-archive branch would become the winner again when its deletion is dropped.
	const states: Array<{
		cand: RankedCandidate;
		state: "present" | "deleted" | "missing";
		markdown: string | null;
	}> = [];
	for (const win of survivors) {
		let markdown: string | null = null;
		if (win.deleted) {
			states.push({ cand: win, state: "deleted", markdown: null });
			continue;
		}
		if (win.source.kind === "worktree" && relPlanPath && opts.worktreePath) {
			const disk = readDiskMarkdown({
				workdir: opts.workdir,
				planPath: opts.planPath,
				relPlanPath,
				worktreePath: opts.worktreePath,
			});
			markdown = disk.markdown;
		} else if (relPlanPath) {
			markdown = await readMarkdownAtCommit(
				opts.workdir,
				win.commit,
				relPlanPath,
			);
		}
		const state =
			markdown !== null
				? "present"
				: relPlanPath &&
						(await lastTouching(session, win.commit, [relPlanPath]))
					? "deleted"
					: "missing";
		states.push({ cand: win, state, markdown });
	}

	if (states.length === 1) {
		const { cand: win, state, markdown } = states[0] as (typeof states)[number];
		if (markdown === null && !win.deleted) {
			const disk = readDiskMarkdown({
				workdir: opts.workdir,
				planPath: opts.planPath,
				relPlanPath,
				worktreePath: opts.worktreePath,
			});
			const base = session.tips.find((tip) =>
				disk.kind === "worktree"
					? tip.worktreePath === opts.worktreePath
					: tip.source.kind === "HEAD",
			)?.sha;
			// A checkout based on the deletion may explicitly recreate the file.
			// An older checkout still carrying it must not resurrect the plan.
			if (
				disk.markdown !== null &&
				(state === "missing" ||
					(base &&
						(base === win.commit ||
							isAncestorInGraph(session.parents, win.commit, base))))
			) {
				return {
					state: "present",
					source: { kind: disk.kind, label: disk.kind, ref: "HEAD" },
					markdown: disk.markdown,
					planPath: relPlanPath ?? opts.planPath,
					commit: null,
				};
			}
		}
		return {
			state,
			source: await maybeBackfilledSource({
				workdir: opts.workdir,
				planSlug: opts.planSlug,
				recordsRelPath: recordsRel,
				source: win.source,
				commit: win.commit,
			}),
			markdown,
			planPath: relPlanPath ?? opts.planPath,
			commit: win.commit,
		};
	}

	const withMd = states
		.filter((s) => s.markdown !== null)
		.map((s) => ({ ...s, pct: phaseCompletionPct(s.markdown as string) }));
	withMd.sort((a, b) => {
		if (a.pct !== b.pct) return b.pct - a.pct;
		return a.cand.source.label.localeCompare(b.cand.source.label);
	});
	const best = withMd[0];
	const diverged_sources = states.map((s) => ({
		...s.cand.source,
		plan_state: s.state,
	}));
	return {
		state: "diverged",
		source: {
			kind: "diverged",
			label: "diverged",
			commit: best?.cand.commit,
		},
		diverged_sources,
		markdown: best?.markdown ?? null,
		planPath: relPlanPath ?? opts.planPath,
		commit: best?.cand.commit ?? survivors[0]?.commit ?? null,
	};
}

export function formatAgeAgo(ageSeconds: number): string {
	if (ageSeconds < 60) return "fetched just now";
	if (ageSeconds < 3600) return `fetched ${Math.floor(ageSeconds / 60)}m ago`;
	if (ageSeconds < 86400)
		return `fetched ${Math.floor(ageSeconds / 3600)}h ago`;
	return `fetched ${Math.floor(ageSeconds / 86400)}d ago`;
}

/** Text-mode provenance line; omitted when the source is the checkout file. */
export function formatProgressSourceLine(
	source: ProgressSource,
): string | null {
	if (source.kind === "worktree" || source.kind === "HEAD") return null;
	const agePart =
		typeof source.age_seconds === "number"
			? ` (${formatAgeAgo(source.age_seconds)})`
			: "";
	return `source: ${source.label}${agePart}`;
}

export function envelopeFromProgress(resolved: ResolvedPlanProgress): {
	plan_state: PlanProgressState;
	source: string;
	source_ref?: string;
	source_commit?: string;
	source_age_seconds?: number;
	diverged_sources?: Array<{
		source: string;
		ref?: string;
		age_seconds?: number;
		plan_state: PlanProgressState;
	}>;
} {
	const out: {
		plan_state: PlanProgressState;
		source: string;
		source_ref?: string;
		source_commit?: string;
		source_age_seconds?: number;
		diverged_sources?: Array<{
			source: string;
			ref?: string;
			age_seconds?: number;
			plan_state: PlanProgressState;
		}>;
	} = { source: resolved.source.label, plan_state: resolved.state };
	if (resolved.source.ref) out.source_ref = resolved.source.ref;
	const commit = resolved.source.commit ?? resolved.commit;
	if (commit) out.source_commit = commit;
	if (typeof resolved.source.age_seconds === "number") {
		out.source_age_seconds = resolved.source.age_seconds;
	}
	if (resolved.diverged_sources && resolved.diverged_sources.length > 0) {
		out.diverged_sources = resolved.diverged_sources.map((s) => ({
			source: s.label,
			plan_state: s.plan_state,
			...(s.ref ? { ref: s.ref } : {}),
			...(typeof s.age_seconds === "number"
				? { age_seconds: s.age_seconds }
				: {}),
		}));
	}
	return out;
}

export async function fetchFiveXWithWarnings(workdir: string): Promise<void> {
	const remotes = await listRemotes(workdir);
	for (const remote of remotes) {
		try {
			await fetchFiveXBranches(workdir, remote);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`Warning: git fetch ${remote} refs/heads/5x/* failed: ${detail}\n`,
			);
		}
	}
}
