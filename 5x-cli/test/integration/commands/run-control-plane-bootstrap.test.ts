import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function fixture(git = true) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "5x-cp-bootstrap-")));
	const app = join(root, "app");
	const plans = join(app, "plans");
	mkdirSync(plans, { recursive: true });
	writeFileSync(
		join(app, "5x.toml"),
		'qualityGates = []\n[paths]\nplans = "plans"\n[author]\nmodel = "subproject-model"\n',
	);
	writeFileSync(join(plans, "plan.md"), "# Plan\n\n## Phase 1\n\n- [ ] Task\n");
	if (git) {
		const result = Bun.spawnSync(["git", "init", root], {
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	return { root, app, plans };
}

function run5x(cwd: string, args: string[]) {
	const result = Bun.spawnSync(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: result.exitCode,
		json: result.stdout.toString().trim().startsWith("{")
			? JSON.parse(result.stdout.toString())
			: null,
		stderr: result.stderr.toString(),
	};
}

/** Write the first log only after watch has created its initially absent directory. */
async function watchFirstLog(cwd: string, logDir: string) {
	expect(existsSync(logDir)).toBe(false);
	const proc = Bun.spawn(
		["bun", "run", BIN, "run", "watch", "--poll-interval", "10"],
		{
			cwd,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let wroteLog = false;
	let stdout = "";
	const poll = setInterval(() => {
		if (!wroteLog && existsSync(logDir)) {
			writeFileSync(
				join(logDir, "agent-001.ndjson"),
				`${JSON.stringify({ type: "text", delta: "first log" })}\n`,
			);
			wroteLog = true;
		}
	}, 10);
	const timer = setTimeout(() => proc.kill("SIGINT"), 10000);
	try {
		const readOutput = async () => {
			for await (const chunk of proc.stdout) {
				stdout += new TextDecoder().decode(chunk);
				if (stdout.includes("first log")) proc.kill("SIGINT");
			}
		};
		const [, stderr, code] = await Promise.all([
			readOutput(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(wroteLog).toBe(true);
		expect(code).toBe(0);
		expect(stderr).not.toContain("[watch]");
		expect(JSON.parse(stdout.trim())).toEqual({
			source: "agent-001.ndjson",
			type: "text",
			delta: "first log",
		});
	} finally {
		clearInterval(poll);
		clearTimeout(timer);
		if (proc.exitCode === null) {
			proc.kill("SIGKILL");
			await proc.exited;
		}
	}
}

describe("repository-owned control-plane bootstrap", () => {
	for (const variant of [
		"default",
		"main-relative",
		"local-relative",
		"local-absolute",
		"local-override",
	] as const) {
		test(
			`fresh subproject run and implicit watch use root state (${variant})`,
			async () => {
				const { root, app, plans } = fixture();
				try {
					const stateDir = join(root, variant === "default" ? ".5x" : "state");
					if (variant === "main-relative") {
						writeFileSync(join(root, "5x.toml"), '[db]\npath = "state"\n');
					} else if (variant !== "default") {
						if (variant === "local-override") {
							writeFileSync(
								join(root, "5x.config.mjs"),
								'export default { db: { path: "overridden-state" } };\n',
							);
						}
						// A local-only root config must participate in bootstrap discovery.
						writeFileSync(
							join(root, "5x.toml.local"),
							`[db]\npath = ${JSON.stringify(variant === "local-absolute" ? stateDir : "state")}\n`,
						);
					}
					writeFileSync(
						join(app, "5x.toml.local"),
						'[db]\npath = "ignored-state"\n',
					);
					const init = run5x(app, [
						"run",
						"init",
						"--plan",
						"plan.md",
						"--allow-dirty",
					]);
					expect(init.code).toBe(0);
					expect(init.json.data.resumed).toBe(false);
					expect(init.json.data.plan_path).toBe(join(plans, "plan.md"));
					const runId = init.json.data.run_id;
					expect(existsSync(join(stateDir, "5x.db"))).toBe(true);
					expect(
						readFileSync(join(stateDir, "current-run"), "utf-8").trim(),
					).toBe(runId);
					expect(existsSync(join(app, ".5x"))).toBe(false);
					expect(existsSync(join(app, "ignored-state"))).toBe(false);
					if (variant !== "default") {
						expect(existsSync(join(root, ".5x", "5x.db"))).toBe(false);
					}

					const state = run5x(app, ["run", "state"]);
					expect(state.code).toBe(0);
					expect(state.json.data.run.id).toBe(runId);
					const rootState = run5x(root, ["run", "state"]);
					expect(rootState.code).toBe(0);
					expect(rootState.json.data.run.id).toBe(runId);

					await watchFirstLog(app, join(stateDir, "logs", runId));
					const complete = run5x(app, [
						"run",
						"complete",
						"--status",
						"aborted",
					]);
					expect(complete.code).toBe(0);
					expect(existsSync(join(stateDir, "current-run"))).toBe(false);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			},
			{ timeout: 30000 },
		);
	}

	test(
		"agent and quality log writers honor absolute root state paths",
		() => {
			const { root, app } = fixture();
			try {
				const stateDir = join(root, "state");
				writeFileSync(
					join(root, "5x.toml.local"),
					`[db]\npath = ${JSON.stringify(stateDir)}\n[author]\nprovider = "sample"\nmodel = "sample/test"\n[sample]\necho = false\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n`,
				);
				const init = run5x(app, [
					"run",
					"init",
					"--plan",
					"plan.md",
					"--allow-dirty",
				]);
				expect(init.code).toBe(0);
				const runId = init.json.data.run_id;
				const logDir = join(stateDir, "logs", runId);
				const invoke = run5x(app, [
					"invoke",
					"author",
					"author-next-phase",
					"--quiet",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=probe",
				]);
				expect(invoke.code).toBe(0);
				expect(invoke.json.data.log_path).toBe(
					join(logDir, "agent-001.ndjson"),
				);
				expect(readFileSync(invoke.json.data.log_path, "utf-8")).toContain(
					"session_start",
				);
				writeFileSync(
					join(app, "5x.toml"),
					'qualityGates = ["bun --version"]\n[paths]\nplans = "plans"\n',
				);
				const quality = run5x(app, ["quality", "run"]);
				expect(quality.code).toBe(0);
				expect(quality.json.data.passed).toBe(true);
				expect(
					readdirSync(logDir).some((file) => file.startsWith("quality-")),
				).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"nested independent repository owns its state even with an external git directory",
		() => {
			const { root, app } = fixture();
			try {
				expect(run5x(root, ["init"]).code).toBe(0);
				const git = Bun.spawnSync(
					["git", "init", "--separate-git-dir", join(root, "git-storage"), app],
					{
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(git.exitCode).toBe(0);
				const init = run5x(app, [
					"run",
					"init",
					"--plan",
					"plan.md",
					"--allow-dirty",
				]);
				expect(init.code).toBe(0);
				expect(existsSync(join(app, ".5x", "5x.db"))).toBe(true);
				expect(existsSync(join(root, "git-storage", "5x.db"))).toBe(false);
				expect(run5x(app, ["run", "state"]).json.data.run.id).toBe(
					init.json.data.run_id,
				);
				expect(run5x(root, ["run", "list"]).json.data.runs).toHaveLength(0);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"plain init from a subproject honors root state configuration",
		() => {
			const { root, app } = fixture();
			try {
				writeFileSync(join(root, "5x.toml.local"), '[db]\npath = "state"\n');
				const init = run5x(app, ["init"]);
				expect(init.code).toBe(0);
				expect(existsSync(join(root, "state", "5x.db"))).toBe(true);
				expect(existsSync(join(root, ".5x", "5x.db"))).toBe(false);
				expect(existsSync(join(app, ".5x"))).toBe(false);
				const run = run5x(app, [
					"run",
					"init",
					"--plan",
					"plan.md",
					"--allow-dirty",
				]);
				expect(run.code).toBe(0);
				expect(run5x(app, ["run", "state"]).json.data.run.id).toBe(
					run.json.data.run_id,
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"lock and doctor discovery use root state before a database exists",
		() => {
			const { root, app } = fixture();
			try {
				writeFileSync(join(root, "5x.toml.local"), '[db]\npath = "state"\n');
				const locksDir = join(root, "state", "locks");
				mkdirSync(locksDir, { recursive: true });
				writeFileSync(join(locksDir, "corrupt.lock"), "not JSON");
				const locks = run5x(app, ["lock", "list"]);
				expect(locks.code).toBe(0);
				expect(locks.json.data.locks).toHaveLength(1);
				expect(locks.json.data.locks[0].lock_path).toBe(
					join(locksDir, "corrupt.lock"),
				);
				const doctor = run5x(app, ["doctor", "--json"]);
				expect(JSON.stringify(doctor.json)).toContain(
					join(root, "state", "5x.db"),
				);
				expect(existsSync(join(app, ".5x"))).toBe(false);
				expect(existsSync(join(root, "state", "5x.db"))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	for (const existingRoot of [false, true]) {
		test(
			`legacy subproject state requires migration (root initialized: ${existingRoot})`,
			() => {
				const { root, app, plans } = fixture();
				try {
					if (existingRoot) expect(run5x(root, ["init"]).code).toBe(0);
					const legacyDb = join(app, ".5x", "5x.db");
					mkdirSync(join(app, ".5x"));
					writeFileSync(legacyDb, "preserve legacy data");
					for (const [cwd, args] of [
						[app, ["run", "init", "--plan", "plan.md", "--allow-dirty"]],
						[
							root,
							[
								"run",
								"init",
								"--plan",
								join(plans, "plan.md"),
								"--allow-dirty",
							],
						],
						[app, ["run", "watch"]],
						[app, ["init"]],
					] as const) {
						const result = run5x(cwd, [...args]);
						expect(result.code).not.toBe(0);
						expect(result.json.error.code).toBe("LEGACY_SUBPROJECT_STATE");
						expect(result.json.error.detail.legacy_db_path).toBe(legacyDb);
						expect(result.json.error.detail.control_plane_db_path).toBe(
							join(root, ".5x", "5x.db"),
						);
						expect(result.json.error.detail.remediation).toContain("Back up");
					}
					expect(readFileSync(legacyDb, "utf-8")).toBe("preserve legacy data");
					expect(existsSync(join(root, ".5x", "5x.db"))).toBe(existingRoot);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			},
			{ timeout: 30000 },
		);
	}

	test(
		"custom legacy state is detected from deeper subproject directories",
		() => {
			const { root, app, plans } = fixture();
			try {
				writeFileSync(join(app, "5x.toml.local"), '[db]\npath = "old-state"\n');
				const legacyDb = join(app, "old-state", "5x.db");
				mkdirSync(join(app, "old-state"));
				writeFileSync(legacyDb, "preserve custom legacy data");
				const state = run5x(plans, ["run", "state"]);
				expect(state.code).not.toBe(0);
				expect(state.json.error.code).toBe("LEGACY_SUBPROJECT_STATE");
				expect(state.json.error.detail.legacy_db_path).toBe(legacyDb);
				expect(readFileSync(legacyDb, "utf-8")).toBe(
					"preserve custom legacy data",
				);
				expect(existsSync(join(root, ".5x"))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"non-Git projects keep their config root and configured state path",
		async () => {
			const { root, app } = fixture(false);
			try {
				writeFileSync(join(app, "5x.toml.local"), '[db]\npath = "state"\n');
				const init = run5x(app, [
					"run",
					"init",
					"--plan",
					"plan.md",
					"--allow-dirty",
				]);
				expect(init.code).toBe(0);
				const state = run5x(app, ["run", "state"]);
				expect(state.code).toBe(0);
				expect(state.json.data.run.id).toBe(init.json.data.run_id);
				expect(existsSync(join(root, ".5x"))).toBe(false);
				await watchFirstLog(
					app,
					join(app, "state", "logs", init.json.data.run_id),
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
