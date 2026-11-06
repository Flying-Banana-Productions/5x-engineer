/**
 * Plan 217 phase 5: the file-form draft repair of a compact issue plan
 * writes only the plan file. The issue brief and its `source/` snapshots,
 * which the plan's pinned `Source brief` line refers to, stay byte-identical.
 */

import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { repairChecklists } from "../../../src/commands/plan-checklist-repair.handler.js";
import { closeDb } from "../../../src/db/connection.js";

const FIXTURE = readFileSync(
	resolve(import.meta.dir, "../../fixtures/issue-resolution/compact-plan.md"),
	"utf-8",
);
const UNMARKED = FIXTURE.replace(/^- \[[ xX]\] /gm, "- ");

/** The file form's result fields this test reads. */
type FileRepairResult = {
	wrote: boolean;
	recorded: boolean;
	repairAvailable: boolean;
	completionAuthorized: boolean;
	intentDigest: string;
};

const BRIEF_DIR = "docs/development/issues/218-issue-42-override-precedence";
const PLAN = "docs/development/plans/218-issue-42-override-precedence.md";

/** Every file under `root` except the CLI state dir, keyed by relative path. */
function snapshot(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const rel = relative(root, path);
			if (rel === ".5x" || rel.startsWith(".5x/")) continue;
			if (statSync(path).isDirectory()) walk(path);
			else files.set(rel, readFileSync(path, "utf8"));
		}
	};
	walk(root);
	return files;
}

describe("file-form checklist repair of a compact issue plan", () => {
	test("writes only the plan; the brief and source/ snapshots are untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-issue-plan-repair-"));
		try {
			const brief = join(dir, BRIEF_DIR);
			mkdirSync(join(brief, "source"), { recursive: true });
			writeFileSync(
				join(brief, "brief.md"),
				"<!-- 5x:issue-source v1 github.com/OWNER/REPO#42 -->\nDisposition: ready\nIntake status: complete\n\n- AC1: project override wins over a user-level value\n- AC2: environment variables still win over both\n",
			);
			writeFileSync(
				join(brief, "source", "issue.md"),
				"Project overrides are ignored.\n- [ ] not a plan checklist\n",
			);
			writeFileSync(join(brief, "source", "comments.json"), "[]\n");
			const planPath = join(dir, PLAN);
			mkdirSync(join(planPath, ".."), { recursive: true });
			writeFileSync(planPath, UNMARKED);
			const before = snapshot(dir);

			const preview = (await repairChecklists({
				planPath,
				dryRun: true,
				startDir: dir,
			})) as FileRepairResult;
			expect(preview.wrote).toBe(false);
			expect(preview.recorded).toBe(false);
			expect(preview.repairAvailable).toBe(true);
			expect(snapshot(dir)).toEqual(before);

			const applied = (await repairChecklists({
				planPath,
				apply: true,
				intent: String(preview.intentDigest),
				startDir: dir,
			})) as FileRepairResult;
			expect(applied.wrote).toBe(true);
			expect(applied.recorded).toBe(false);
			expect(applied.completionAuthorized).toBe(false);

			const after = snapshot(dir);
			expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
			for (const [path, bytes] of before) {
				if (path === PLAN) continue;
				expect(after.get(path)).toBe(bytes);
			}
			// The plan returns to the compact fixture exactly.
			expect(after.get(PLAN)).toBe(FIXTURE);
		} finally {
			closeDb();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
