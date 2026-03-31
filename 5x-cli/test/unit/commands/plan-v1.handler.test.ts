/**
 * Direct-call unit tests for `planList` — no CLI subprocess.
 *
 * Each case uses an isolated temp git checkout + chdir so `resolveDbContext()`
 * resolves DB and paths locally (see AGENTS.md: unit tier).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { planList } from "../../../src/commands/plan-v1.handler.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/schema.js";
import { setOutputFormat, setPrettyPrint } from "../../../src/output.js";
import { canonicalizePlanPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
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

function openProjectDb(projectRoot: string) {
	closeDb();
	_resetForTest();
	const db = getDb(projectRoot);
	runMigrations(db);
	return db;
}

function captureStderrWrite(): {
	lines: string[];
	restore: () => void;
} {
	const lines: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array) => {
		const s =
			typeof chunk === "string"
				? chunk
				: new TextDecoder().decode(chunk as Uint8Array);
		lines.push(s);
		return true;
	};
	return {
		lines,
		restore: () => {
			process.stderr.write = orig;
		},
	};
}

async function withProject<T>(
	fn: (ctx: { root: string; plansDir: string }) => Promise<T>,
): Promise<T> {
	const prevCwd = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "5x-planlist-"));
	setupGitProject(root);
	const plansDir = join(root, "docs", "development");
	process.chdir(root);
	setOutputFormat("json");
	setPrettyPrint(false);
	try {
		return await fn({ root, plansDir });
	} finally {
		closeDb();
		_resetForTest();
		process.chdir(prevCwd);
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function insertRun(
	db: ReturnType<typeof getDb>,
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
	db: ReturnType<typeof getDb>,
	planPath: string,
	worktreePath: string | null,
): void {
	db.query(`INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)`).run(
		planPath,
		worktreePath,
	);
}

afterEach(() => {
	setOutputFormat("json");
	setPrettyPrint(false);
});

describe("planList handler", () => {
	test("recursively discovers nested markdown plans but skips paths.reviews under paths.plans", async () => {
		await withProject(async ({ plansDir }) => {
			mkdirSync(join(plansDir, "deep", "nest"), { recursive: true });
			writeFileSync(
				join(plansDir, "deep", "nest", "inner.md"),
				`# Inner\n\n## Phase 1: A\n\n- [x] t\n`,
			);
			writeFileSync(
				join(plansDir, "root.md"),
				`# R\n\n## Phase 1: B\n\n- [ ] u\n`,
			);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			const { lines, restore } = captureStderrWrite();
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
				restore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				ok: boolean;
				data: { plans: { plan_path: string }[] };
			};
			expect(env.ok).toBe(true);
			const paths = env.data.plans.map((p) => p.plan_path).sort();
			expect(paths).toEqual(["deep/nest/inner.md", "root.md"]);
			expect(lines.join("")).toBe("");
		});
	});

	test("does not list markdown under paths.reviews inside paths.plans", async () => {
		await withProject(async ({ plansDir }) => {
			const reviewsDir = join(plansDir, "reviews");
			mkdirSync(join(reviewsDir, "nested"), { recursive: true });
			writeFileSync(
				join(reviewsDir, "nested", "impl-review.md"),
				`# Review\n\n## Phase 1: A\n\n- [x] t\n`,
			);
			writeFileSync(
				join(plansDir, "real.md"),
				`# Real\n\n## Phase 1: B\n\n- [ ] u\n`,
			);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				ok: boolean;
				data: { plans: { plan_path: string }[] };
			};
			expect(env.ok).toBe(true);
			const paths = env.data.plans.map((p) => p.plan_path).sort();
			expect(paths).toEqual(["real.md"]);
		});
	});

	test("duplicate basenames in different subdirectories are distinct plan_path values", async () => {
		await withProject(async ({ plansDir }) => {
			for (const d of ["nest1", "nest2"]) {
				mkdirSync(join(plansDir, d), { recursive: true });
				writeFileSync(
					join(plansDir, d, "same.md"),
					`# ${d}\n\n## Phase 1: X\n\n- [ ] a\n`,
				);
			}

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				data: { plans: { plan_path: string; name: string }[] };
			};
			const paths = env.data.plans.map((p) => p.plan_path).sort();
			expect(paths).toEqual(["nest1/same.md", "nest2/same.md"]);
			// Basename slug matches; stable identity is plan_path.
			expect(env.data.plans.every((p) => p.name === "same")).toBe(true);
		});
	});

	test("missing plans directory returns empty list without throwing", async () => {
		await withProject(async () => {
			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				ok: boolean;
				data: { plans: unknown[]; plans_dir: string };
			};
			expect(env.ok).toBe(true);
			expect(env.data.plans).toEqual([]);
			expect(existsSync(env.data.plans_dir)).toBe(false);
		});
	});

	test("--exclude-finished filters complete plans", async () => {
		await withProject(async ({ plansDir }) => {
			mkdirSync(plansDir, { recursive: true });
			writeFileSync(
				join(plansDir, "done.md"),
				`# D\n\n## Phase 1: A\n\n- [x] a\n`,
			);
			writeFileSync(
				join(plansDir, "todo.md"),
				`# T\n\n## Phase 1: B\n\n- [ ] b\n`,
			);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({ excludeFinished: true });
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				data: { plans: { plan_path: string }[] };
			};
			expect(env.data.plans.map((p) => p.plan_path)).toEqual(["todo.md"]);
		});
	});

	test("sorts unfinished first, then complete; ties broken by plan_path alpha", async () => {
		await withProject(async ({ plansDir }) => {
			mkdirSync(plansDir, { recursive: true });
			writeFileSync(
				join(plansDir, "zzz_complete.md"),
				`# Z\n\n## Phase 1: A\n\n- [x] a\n`,
			);
			writeFileSync(
				join(plansDir, "mmm_complete.md"),
				`# M\n\n## Phase 1: B\n\n- [x] b\n`,
			);
			writeFileSync(
				join(plansDir, "aaa_incomplete.md"),
				`# A\n\n## Phase 1: C\n\n- [ ] c\n`,
			);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				data: { plans: { plan_path: string; status: string }[] };
			};
			expect(env.data.plans.map((p) => p.plan_path)).toEqual([
				"aaa_incomplete.md",
				"mmm_complete.md",
				"zzz_complete.md",
			]);
			expect(env.data.plans[0]?.status).toBe("incomplete");
			expect(env.data.plans[1]?.status).toBe("complete");
			expect(env.data.plans[2]?.status).toBe("complete");
		});
	});

	test("mapped worktree with on-disk copy prefers worktree markdown", async () => {
		await withProject(async ({ root, plansDir }) => {
			const relUnderRoot = relative(root, join(plansDir, "wt.plan.md"));
			const rootMd = `# Root\n\n## Phase 1: One\n\n- [ ] root\n`;
			const wtMd = `# Worktree\n\n## Phase 1: One\n\n- [x] wt\n`;
			mkdirSync(join(plansDir), { recursive: true });
			writeFileSync(join(plansDir, "wt.plan.md"), rootMd);

			const wtRoot = mkdtempSync(join(tmpdir(), "5x-planlist-wt-"));
			try {
				const mirrored = join(wtRoot, relUnderRoot);
				mkdirSync(join(mirrored, ".."), { recursive: true });
				writeFileSync(mirrored, wtMd);

				const db = openProjectDb(root);
				const canon = canonicalizePlanPath(join(plansDir, "wt.plan.md"));
				insertPlanRow(db, canon, wtRoot);

				const logs: string[] = [];
				const logSpy = spyOn(console, "log").mockImplementation(
					(msg?: unknown) => {
						logs.push(String(msg));
					},
				);
				try {
					await planList({});
				} finally {
					logSpy.mockRestore();
				}

				const env = JSON.parse(logs[0] ?? "{}") as {
					data: {
						plans: { title: string; status: string; completion_pct: number }[];
					};
				};
				const row = env.data.plans.find(
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
		await withProject(async ({ plansDir }) => {
			mkdirSync(plansDir, { recursive: true });
			const bad = join(plansDir, "unreadable.md");
			const good = join(plansDir, "good.md");
			writeFileSync(bad, `# B\n\n## Phase 1: X\n\n- [x] a\n`);
			writeFileSync(good, `# G\n\n## Phase 1: Y\n\n- [x] b\n`);

			chmodSync(bad, 0o000);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			const { lines, restore } = captureStderrWrite();
			try {
				await planList({});
			} finally {
				restore();
				logSpy.mockRestore();
				try {
					chmodSync(bad, 0o644);
				} catch {
					/* ignore */
				}
			}

			const stderr = lines.join("");
			expect(stderr).toContain("could not read");
			expect(stderr).toContain("unreadable.md");

			const env = JSON.parse(logs[0] ?? "{}") as {
				data: {
					plans: { plan_path: string; completion_pct: number; title: string }[];
				};
			};
			const byPath = Object.fromEntries(
				env.data.plans.map((p) => [p.plan_path, p]),
			);
			expect(byPath["unreadable.md"]?.completion_pct).toBe(0);
			expect(byPath["unreadable.md"]?.title).toBe("");
			expect(byPath["good.md"]?.completion_pct).toBe(100);
		});
	});

	test("non-plan markdown emits stderr warning only; JSON envelope has no warning text", async () => {
		await withProject(async ({ plansDir }) => {
			mkdirSync(plansDir, { recursive: true });
			writeFileSync(
				join(plansDir, "notes.md"),
				"# Notes\n\nNot a plan body.\n",
			);
			writeFileSync(
				join(plansDir, "real.md"),
				`# Real\n\n## Phase 1: One\n\n- [ ] t\n`,
			);

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			const { lines, restore } = captureStderrWrite();
			try {
				await planList({});
			} finally {
				restore();
				logSpy.mockRestore();
			}

			const stderr = lines.join("");
			expect(stderr).toContain("notes.md");
			expect(stderr).toContain("no implementation-plan phases");

			const raw = logs[0] ?? "";
			expect(raw.toLowerCase()).not.toContain("warning");
			const env = JSON.parse(raw) as { ok: boolean; data: unknown };
			expect(env.ok).toBe(true);
			expect(JSON.stringify(env.data).toLowerCase()).not.toContain("warning");
		});
	});

	test("associates runs with plans by canonical plan_path", async () => {
		await withProject(async ({ plansDir }) => {
			mkdirSync(plansDir, { recursive: true });
			const path = join(plansDir, "tracked.md");
			writeFileSync(path, `# T\n\n## Phase 1: A\n\n- [ ] x\n`);
			const db = openProjectDb(process.cwd());
			const canon = canonicalizePlanPath(path);
			insertRun(db, "run_unitactive01", canon, "active");

			const logs: string[] = [];
			const logSpy = spyOn(console, "log").mockImplementation(
				(msg?: unknown) => {
					logs.push(String(msg));
				},
			);
			try {
				await planList({});
			} finally {
				logSpy.mockRestore();
			}

			const env = JSON.parse(logs[0] ?? "{}") as {
				data: {
					plans: {
						plan_path: string;
						runs_total: number;
						active_run: string | null;
					}[];
				};
			};
			const row = env.data.plans.find((p) => p.plan_path === "tracked.md");
			expect(row?.runs_total).toBe(1);
			expect(row?.active_run).toBe("run_unitactive01");
		});
	});
});
