/**
 * Direct-call unit tests for `planList` — no CLI subprocess.
 *
 * Each case uses an isolated temp git checkout, owned SQLite connection, and
 * injected `startDir` / `dbContext` so tests stay off `process.chdir` and the
 * process-wide `getDb` singleton (see AGENTS.md: unit tier, `--concurrent`).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { DbContext } from "../../../src/commands/context.js";
import {
	type PlanListParams,
	planList,
} from "../../../src/commands/plan-v1.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { runMigrations } from "../../../src/db/schema.js";
import { canonicalizePlanPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

interface ProjectCtx {
	root: string;
	plansDir: string;
	db: Database;
	dbContext: DbContext;
}

function setupGitProject(dir: string): void {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function resolvedConfig(root: string) {
	const raw = FiveXConfigSchema.parse({});
	return {
		...raw,
		paths: {
			...raw.paths,
			plans: resolve(root, raw.paths.plans),
			reviews: resolve(root, raw.paths.reviews),
			archive: resolve(root, raw.paths.archive),
			records: resolve(root, raw.paths.records),
			templates: {
				plan: resolve(root, raw.paths.templates.plan),
				review: resolve(root, raw.paths.templates.review),
			},
		},
	};
}

function openOwnedDb(projectRoot: string): Database {
	mkdirSync(join(projectRoot, ".5x"), { recursive: true });
	const db = new Database(resolve(projectRoot, ".5x/5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);
	return db;
}

function setupProject(): ProjectCtx {
	const root = mkdtempSync(join(tmpdir(), "5x-planlist-"));
	setupGitProject(root);
	const db = openOwnedDb(root);
	const config = resolvedConfig(root);
	const dbContext: DbContext = {
		projectRoot: root,
		config,
		db,
		controlPlane: {
			controlPlaneRoot: root,
			stateDir: ".5x",
			mode: "isolated",
		},
	};
	return { root, plansDir: config.paths.plans, db, dbContext };
}

function teardown(ctx: ProjectCtx): void {
	try {
		ctx.db.close();
	} catch {
		/* already closed */
	}
	try {
		rmSync(ctx.root, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

async function withProject<T>(fn: (ctx: ProjectCtx) => Promise<T>): Promise<T> {
	const ctx = setupProject();
	try {
		return await fn(ctx);
	} finally {
		teardown(ctx);
	}
}

async function listPlans(
	ctx: ProjectCtx,
	params: Omit<PlanListParams, "startDir" | "dbContext" | "warn"> = {},
): Promise<{
	plans_dir: string;
	plans: Awaited<ReturnType<typeof planList>>["plans"];
	warnings: string;
}> {
	const warnings: string[] = [];
	const result = await planList({
		...params,
		startDir: ctx.root,
		dbContext: ctx.dbContext,
		warn: (message) => {
			warnings.push(message);
		},
	});
	return { ...result, warnings: warnings.join("") };
}

function insertRun(
	db: Database,
	id: string,
	planPath: string,
	status: string,
): void {
	db.query(`INSERT INTO runs (id, plan_path, status) VALUES (?1, ?2, ?3)`).run(
		id,
		planPath,
		status,
	);
}

function insertPlanRow(
	db: Database,
	planPath: string,
	worktreePath: string | null,
): void {
	db.query(`INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)`).run(
		planPath,
		worktreePath,
	);
}

describe("planList handler", () => {
	test("recursively discovers nested markdown plans but skips paths.reviews under paths.plans", async () => {
		await withProject(async (ctx) => {
			mkdirSync(join(ctx.plansDir, "deep", "nest"), { recursive: true });
			writeFileSync(
				join(ctx.plansDir, "deep", "nest", "inner.md"),
				`# Inner\n\n## Phase 1: A\n\n- [x] t\n`,
			);
			writeFileSync(
				join(ctx.plansDir, "root.md"),
				`# R\n\n## Phase 1: B\n\n- [ ] u\n`,
			);

			const { plans, warnings } = await listPlans(ctx);
			expect(plans.map((p) => p.plan_path).sort()).toEqual([
				"deep/nest/inner.md",
				"root.md",
			]);
			expect(warnings).toBe("");
		});
	});

	test("does not list markdown under paths.reviews inside paths.plans", async () => {
		await withProject(async (ctx) => {
			const reviewsDir = join(ctx.plansDir, "reviews");
			mkdirSync(join(reviewsDir, "nested"), { recursive: true });
			writeFileSync(
				join(reviewsDir, "nested", "impl-review.md"),
				`# Review\n\n## Phase 1: A\n\n- [x] t\n`,
			);
			writeFileSync(
				join(ctx.plansDir, "real.md"),
				`# Real\n\n## Phase 1: B\n\n- [ ] u\n`,
			);

			const { plans } = await listPlans(ctx);
			expect(plans.map((p) => p.plan_path).sort()).toEqual(["real.md"]);
		});
	});

	test("duplicate basenames in different subdirectories are distinct plan_path values", async () => {
		await withProject(async (ctx) => {
			for (const d of ["nest1", "nest2"]) {
				mkdirSync(join(ctx.plansDir, d), { recursive: true });
				writeFileSync(
					join(ctx.plansDir, d, "same.md"),
					`# ${d}\n\n## Phase 1: X\n\n- [ ] a\n`,
				);
			}

			const { plans } = await listPlans(ctx);
			expect(plans.map((p) => p.plan_path).sort()).toEqual([
				"nest1/same.md",
				"nest2/same.md",
			]);
			expect(plans.every((p) => p.name === "same")).toBe(true);
		});
	});

	test("missing plans directory returns empty list without throwing", async () => {
		await withProject(async (ctx) => {
			const { plans, plans_dir } = await listPlans(ctx);
			expect(plans).toEqual([]);
			expect(existsSync(plans_dir)).toBe(false);
		});
	});

	test("--exclude-finished filters complete plans", async () => {
		await withProject(async (ctx) => {
			mkdirSync(ctx.plansDir, { recursive: true });
			writeFileSync(
				join(ctx.plansDir, "done.md"),
				`# D\n\n## Phase 1: A\n\n- [x] a\n`,
			);
			writeFileSync(
				join(ctx.plansDir, "todo.md"),
				`# T\n\n## Phase 1: B\n\n- [ ] b\n`,
			);

			const { plans } = await listPlans(ctx, { excludeFinished: true });
			expect(plans.map((p) => p.plan_path)).toEqual(["todo.md"]);
		});
	});

	test("sorts by completion pct desc then mtime asc; plan_path tie-break", async () => {
		await withProject(async (ctx) => {
			mkdirSync(ctx.plansDir, { recursive: true });
			writeFileSync(
				join(ctx.plansDir, "zzz_complete.md"),
				`# Z\n\n## Phase 1: A\n\n- [x] a\n`,
			);
			writeFileSync(
				join(ctx.plansDir, "mmm_complete.md"),
				`# M\n\n## Phase 1: B\n\n- [x] b\n`,
			);
			writeFileSync(
				join(ctx.plansDir, "aaa_incomplete.md"),
				`# A\n\n## Phase 1: C\n\n- [ ] c\n`,
			);
			const tZ = new Date("2019-01-01T00:00:00Z");
			const tM = new Date("2019-02-01T00:00:00Z");
			const tA = new Date("2019-03-01T00:00:00Z");
			utimesSync(join(ctx.plansDir, "zzz_complete.md"), tZ, tZ);
			utimesSync(join(ctx.plansDir, "mmm_complete.md"), tM, tM);
			utimesSync(join(ctx.plansDir, "aaa_incomplete.md"), tA, tA);

			const { plans } = await listPlans(ctx);
			expect(plans.map((p) => p.plan_path)).toEqual([
				"zzz_complete.md",
				"mmm_complete.md",
				"aaa_incomplete.md",
			]);
			expect(plans[0]?.status).toBe("complete");
			expect(plans[1]?.status).toBe("complete");
			expect(plans[2]?.status).toBe("incomplete");
		});
	});

	test("mapped worktree with on-disk copy prefers worktree markdown", async () => {
		await withProject(async (ctx) => {
			const relUnderRoot = relative(ctx.root, join(ctx.plansDir, "wt.plan.md"));
			const rootMd = `# Root\n\n## Phase 1: One\n\n- [ ] root\n`;
			const wtMd = `# Worktree\n\n## Phase 1: One\n\n- [x] wt\n`;
			mkdirSync(join(ctx.plansDir), { recursive: true });
			writeFileSync(join(ctx.plansDir, "wt.plan.md"), rootMd);

			const wtRoot = mkdtempSync(join(tmpdir(), "5x-planlist-wt-"));
			try {
				const mirrored = join(wtRoot, relUnderRoot);
				mkdirSync(join(mirrored, ".."), { recursive: true });
				writeFileSync(mirrored, wtMd);

				const canon = canonicalizePlanPath(join(ctx.plansDir, "wt.plan.md"));
				insertPlanRow(ctx.db, canon, wtRoot);

				const { plans } = await listPlans(ctx);
				const row = plans.find(
					(p) => p.title === "Worktree" || p.title === "Root",
				);
				expect(row?.title).toBe("Worktree");
				expect(row?.status).toBe("complete");
				expect(row?.completion_pct).toBe(100);
			} finally {
				rmSync(wtRoot, { recursive: true, force: true });
			}
		});
	});

	test("read failure on one file yields incomplete fallback and other files still list", async () => {
		await withProject(async (ctx) => {
			mkdirSync(ctx.plansDir, { recursive: true });
			const bad = join(ctx.plansDir, "unreadable.md");
			const good = join(ctx.plansDir, "good.md");
			writeFileSync(bad, `# B\n\n## Phase 1: X\n\n- [x] a\n`);
			writeFileSync(good, `# G\n\n## Phase 1: Y\n\n- [x] b\n`);

			chmodSync(bad, 0o000);
			try {
				const { plans, warnings } = await listPlans(ctx);
				expect(warnings).toContain("could not read");
				expect(warnings).toContain("unreadable.md");

				const byPath = Object.fromEntries(plans.map((p) => [p.plan_path, p]));
				expect(byPath["unreadable.md"]?.completion_pct).toBe(0);
				expect(byPath["unreadable.md"]?.title).toBe("");
				expect(byPath["good.md"]?.completion_pct).toBe(100);
			} finally {
				try {
					chmodSync(bad, 0o644);
				} catch {
					/* ignore */
				}
			}
		});
	});

	test("non-plan markdown emits stderr warning only; JSON envelope has no warning text", async () => {
		await withProject(async (ctx) => {
			mkdirSync(ctx.plansDir, { recursive: true });
			writeFileSync(
				join(ctx.plansDir, "notes.md"),
				"# Notes\n\nNot a plan body.\n",
			);
			writeFileSync(
				join(ctx.plansDir, "real.md"),
				`# Real\n\n## Phase 1: One\n\n- [ ] t\n`,
			);

			const { plans, warnings } = await listPlans(ctx);
			expect(warnings).toContain("notes.md");
			expect(warnings).toContain("no implementation-plan phases");
			expect(JSON.stringify(plans).toLowerCase()).not.toContain("warning");
		});
	});

	test("associates runs with plans by canonical plan_path", async () => {
		await withProject(async (ctx) => {
			mkdirSync(ctx.plansDir, { recursive: true });
			const path = join(ctx.plansDir, "tracked.md");
			writeFileSync(path, `# T\n\n## Phase 1: A\n\n- [ ] x\n`);
			const canon = canonicalizePlanPath(path);
			insertRun(ctx.db, "run_unitactive01", canon, "active");

			const { plans } = await listPlans(ctx);
			const row = plans.find((p) => p.plan_path === "tracked.md");
			expect(row?.runs_total).toBe(1);
			expect(row?.active_run).toBe("run_unitactive01");
		});
	});

	test("isolated projects list concurrently without sharing cwd or getDb", async () => {
		const listing = async (name: string) =>
			withProject(async (ctx) => {
				mkdirSync(ctx.plansDir, { recursive: true });
				writeFileSync(
					join(ctx.plansDir, `${name}.md`),
					`# ${name}\n\n## Phase 1: A\n\n- [ ] x\n`,
				);
				const { plans } = await listPlans(ctx);
				expect(plans.map((p) => p.plan_path)).toEqual([`${name}.md`]);
				expect(plans[0]?.title).toBe(name);
			});

		await Promise.all([listing("alpha"), listing("beta")]);
	});
});
