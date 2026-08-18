/**
 * Doctor check: dead worktree mappings and orphan directories.
 *
 * Detect opens the existing DB read-only and never creates or migrates it.
 * `--fix` clears dead mappings with a writable open of the existing file and
 * `upsertPlan` — it never detaches via the worktree command and never removes
 * git worktrees or directories.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly } from "../../db/connection.js";
import { upsertPlan } from "../../db/operations.js";
import { listWorktrees } from "../../git.js";
import { realpathExisting } from "../../paths.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";

export const WORKTREES_CHECK_ID = "worktrees";

interface MappedWorktree {
	plan_path: string;
	worktree_path: string;
	branch: string | null;
}

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function dbUnreadable(ctx: DoctorCheckContext, err: unknown): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: WORKTREES_CHECK_ID,
		status: "fail",
		code: "DB_UNREADABLE",
		message: `cannot read database at ${ctx.dbPath}: ${message}`,
		fixable: false,
		detail: { dbPath: ctx.dbPath, error: message },
	};
}

function mappingMissing(path: string): boolean {
	try {
		return !existsSync(path);
	} catch {
		return true;
	}
}

function worktreesDir(ctx: DoctorCheckContext): string {
	return join(ctx.projectRoot, ctx.stateDir ?? ".5x", "worktrees");
}

async function collectOrphanPaths(
	ctx: DoctorCheckContext,
	mapped: Set<string>,
): Promise<string[]> {
	const candidates = new Set<string>();
	const primary = realpathExisting(ctx.projectRoot);

	try {
		const gitWorktrees = await listWorktrees(ctx.projectRoot);
		for (const wt of gitWorktrees) {
			const normalized = realpathExisting(wt.path);
			if (normalized === primary) continue;
			candidates.add(normalized);
		}
	} catch {
		// Not a git repo / git unavailable — filesystem orphans still apply.
	}

	const dir = worktreesDir(ctx);
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			candidates.add(realpathExisting(join(dir, entry.name)));
		}
	}

	const orphans: string[] = [];
	for (const candidate of candidates) {
		if (!mapped.has(candidate) && existsSync(candidate)) {
			orphans.push(candidate);
		}
	}
	orphans.sort();
	return orphans;
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	if (!existsSync(ctx.dbPath)) return [];

	let plans: MappedWorktree[] = [];
	let db: Database | undefined;
	try {
		db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
		plans = db
			.query(
				"SELECT plan_path, worktree_path, branch FROM plans WHERE worktree_path IS NOT NULL AND worktree_path != ''",
			)
			.all() as MappedWorktree[];
	} catch (err) {
		return [dbUnreadable(ctx, err)];
	} finally {
		try {
			db?.close();
		} catch {
			// already closed
		}
	}

	const findings: DoctorFinding[] = [];
	const mapped = new Set<string>();

	for (const plan of plans) {
		const worktreePath = plan.worktree_path;
		mapped.add(realpathExisting(worktreePath));
		if (mappingMissing(worktreePath)) {
			findings.push({
				check: WORKTREES_CHECK_ID,
				status: "fail",
				code: "WORKTREE_MAPPING_MISSING",
				message: `worktree mapping for ${plan.plan_path} points at missing path ${worktreePath}`,
				remediation: `5x worktree detach -p ${plan.plan_path}`,
				fixable: true,
				detail: {
					planPath: plan.plan_path,
					worktreePath,
				},
			});
		}
	}

	for (const orphanPath of await collectOrphanPaths(ctx, mapped)) {
		findings.push({
			check: WORKTREES_CHECK_ID,
			status: "warn",
			code: "WORKTREE_ORPHAN",
			message: `orphan worktree directory ${orphanPath} has no plan mapping`,
			remediation:
				"Inspect the unused worktree; doctor --fix will not delete directories",
			fixable: false,
			detail: { worktreePath: orphanPath },
		});
	}

	if (findings.length === 0) {
		return [
			{
				check: WORKTREES_CHECK_ID,
				status: "ok",
				code: "WORKTREES_OK",
				message: "worktree mappings are healthy",
				fixable: false,
			},
		];
	}

	return findings;
}

async function fix(
	finding: DoctorFinding,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (finding.code !== "WORKTREE_MAPPING_MISSING") {
		return { attempted: false, message: "not a dead worktree mapping" };
	}

	const planPath = String(asRecord(finding.detail).planPath ?? "");
	if (!planPath) {
		return { attempted: false, message: "missing planPath" };
	}
	if (!existsSync(ctx.dbPath)) {
		return { attempted: false, message: "database missing" };
	}

	const db = new Database(ctx.dbPath);
	try {
		upsertPlan(db, { planPath, worktreePath: "", branch: "" });
		return {
			attempted: true,
			message: `cleared dead worktree mapping for ${planPath}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { attempted: false, message };
	} finally {
		db.close();
	}
}

export const worktreesCheck: DoctorCheck = {
	id: WORKTREES_CHECK_ID,
	run,
	fix,
};
