/**
 * Origin attribution for live writers: protocol, direct record, commit,
 * human steps, prompt decisions, and actor redaction.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RecordPerformer } from "../../../src/control-plane/index.js";
import {
	createMemoryRecordStore,
	RECORD_LINE_SCHEMA_VERSION,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { IDENTITY_FILENAME } from "../../../src/records/identity.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const FORBIDDEN = [
	"hostname",
	"hardware_id",
	"os_username",
	"username",
	"session_id",
	"log_path",
	"transcript",
	"git_user",
	"user_email",
];

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-origin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

async function run5x(
	cwd: string,
	args: string[],
	opts?: { extraEnv?: Record<string, string | undefined>; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...cleanGitEnv(), ...opts?.extraEnv },
		stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (opts?.stdin !== undefined && proc.stdin) {
		proc.stdin.write(opts.stdin);
		proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function setupProject(dir: string): { planPath: string } {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return { planPath };
}

function runDir(root: string, runId: string): string {
	return join(root, "docs", "development", "runs", "test-plan", runId);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function performerOf(line: Record<string, unknown>): Record<string, unknown> {
	const origin = line.origin as Record<string, unknown>;
	return origin.performer as Record<string, unknown>;
}

function assertNoForbidden(text: string): void {
	for (const key of FORBIDDEN) {
		expect(text).not.toContain(`"${key}"`);
	}
}

const TEST_INSTALLATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function writeIdentity(
	configHome: string,
	overrides: { actor?: string; installation_id?: string } = {},
): void {
	writeFileSync(
		join(configHome, IDENTITY_FILENAME),
		`${JSON.stringify(
			{
				version: 1,
				installation_id: overrides.installation_id ?? TEST_INSTALLATION_ID,
				...(overrides.actor ? { actor: overrides.actor } : {}),
			},
			null,
			2,
		)}\n`,
	);
}

function assertRedactedRecorder(
	recorder: { actor?: string; installation_id?: string } | undefined,
): void {
	expect(recorder?.actor).toBeUndefined();
	expect(recorder?.installation_id).toBeTruthy();
}

describe("origin attribution", () => {
	test(
		"protocol author/reviewer, direct record, commit, and human steps stamp expected performers",
		async () => {
			const dir = makeTmpDir();
			const configHome = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const extraEnv = { FIVEX_CONFIG_HOME: configHome };
				writeIdentity(configHome);
				const init = await run5x(dir, ["run", "init", "--plan", planPath], {
					extraEnv,
				});
				expect(init.exitCode).toBe(0);
				const runId = (JSON.parse(init.stdout) as { data: { run_id: string } })
					.data.run_id;

				const author = await run5x(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						runId,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"1",
						"--iteration",
						"1",
						"--no-phase-checklist-validate",
					],
					{
						extraEnv,
						stdin: JSON.stringify({ result: "complete", commit: "abc123def" }),
					},
				);
				expect(author.exitCode).toBe(0);

				const reviewer = await run5x(
					dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						runId,
						"--record",
						"--step",
						"reviewer:plan",
						"--phase",
						"1",
						"--iteration",
						"1",
					],
					{
						extraEnv,
						stdin: JSON.stringify({
							readiness: "ready",
							items: [],
							summary: "Looks good",
						}),
					},
				);
				expect(reviewer.exitCode).toBe(0);

				const direct = await run5x(
					dir,
					[
						"run",
						"record",
						"author:impl:status",
						"--run",
						runId,
						"--result",
						'{"ok":true}',
						"--phase",
						"1",
					],
					{ extraEnv },
				);
				expect(direct.exitCode).toBe(0);

				const human = await run5x(
					dir,
					[
						"run",
						"record",
						"human:approve",
						"--run",
						runId,
						"--result",
						'{"ok":true}',
						"--phase",
						"1",
					],
					{ extraEnv },
				);
				expect(human.exitCode).toBe(0);

				writeFileSync(join(dir, "src-foo.ts"), "export const n = 1;\n");
				const commit = await run5x(
					dir,
					[
						"commit",
						"--run",
						runId,
						"-m",
						"code",
						"--files",
						"src-foo.ts",
						"--phase",
						"1",
					],
					{ extraEnv },
				);
				expect(commit.exitCode).toBe(0);

				const steps = readJsonl(join(runDir(dir, runId), "steps.jsonl"));
				const byName = Object.fromEntries(
					steps.map((line) => [
						(line.payload as { step_name: string }).step_name,
						line,
					]),
				);
				expect(performerOf(byName["author:implement"] ?? {})).toEqual({
					kind: "agent",
					role: "author",
				});
				expect(performerOf(byName["reviewer:plan"] ?? {})).toEqual({
					kind: "agent",
					role: "reviewer",
				});
				expect(performerOf(byName["author:impl:status"] ?? {})).toEqual({
					kind: "system",
					role: "cli",
				});
				expect(performerOf(byName["human:approve"] ?? {})).toEqual({
					kind: "human",
					role: "operator",
				});
				expect(performerOf(byName["git:commit"] ?? {})).toEqual({
					kind: "system",
					role: "cli",
				});
				const recorded = byName["author:impl:status"];
				expect(recorded?.schema_version).toBe(RECORD_LINE_SCHEMA_VERSION);
				expect(recorded?.provenance).toBe("recorded");
				expect(
					(recorded?.origin as { recorder?: { installation_id?: string } })
						?.recorder?.installation_id,
				).toBe(TEST_INSTALLATION_ID);
				assertNoForbidden(
					readFileSync(join(runDir(dir, runId), "steps.jsonl"), "utf-8"),
				);

				const prompt = await run5x(
					dir,
					[
						"prompt",
						"confirm",
						"Continue?",
						"--default",
						"yes",
						"--run",
						runId,
					],
					{ extraEnv },
				);
				expect(prompt.exitCode).toBe(0);
				const decisions = readJsonl(
					join(runDir(dir, runId), "decisions.jsonl"),
				);
				const promptDecision = decisions.find(
					(line) =>
						(line.payload as { kind?: string }).kind === "answered-prompt",
				);
				expect(performerOf(promptDecision ?? {})).toEqual({
					kind: "human",
					role: "operator",
				});
			} finally {
				cleanupDir(dir);
				cleanupDir(configHome);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --record stamps agent performer with configured provider for author and reviewer",
		async () => {
			const dir = makeTmpDir();
			const configHome = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					`[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n`,
				);
				git(["add", "5x.toml"], dir);
				git(["commit", "-m", "sample provider"], dir);

				const extraEnv = { FIVEX_CONFIG_HOME: configHome };
				const init = await run5x(dir, ["run", "init", "--plan", planPath], {
					extraEnv,
				});
				expect(init.exitCode).toBe(0);
				const runId = (JSON.parse(init.stdout) as { data: { run_id: string } })
					.data.run_id;

				const author = await run5x(
					dir,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--run",
						runId,
						"--record",
						"--var",
						`plan_path=${planPath}`,
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=test",
					],
					{ extraEnv },
				);
				expect(author.exitCode).toBe(0);

				writeFileSync(
					join(dir, "5x.toml"),
					`[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nreadiness = "ready"\nitems = []\nsummary = "Looks good"\n`,
				);

				const reviewer = await run5x(
					dir,
					[
						"invoke",
						"reviewer",
						"reviewer-plan",
						"--run",
						runId,
						"--record",
						"--var",
						`plan_path=${planPath}`,
						"--var",
						"review_path=docs/development/reviews/r.md",
					],
					{ extraEnv },
				);
				expect(reviewer.exitCode).toBe(0);

				const steps = readJsonl(join(runDir(dir, runId), "steps.jsonl"));
				const byName = Object.fromEntries(
					steps.map((line) => [
						(line.payload as { step_name: string }).step_name,
						line,
					]),
				);
				expect(performerOf(byName["author:implement"] ?? {})).toEqual({
					kind: "agent",
					role: "author",
					provider: "sample",
				});
				expect(performerOf(byName["reviewer:review"] ?? {})).toEqual({
					kind: "agent",
					role: "reviewer",
					provider: "sample",
				});
			} finally {
				cleanupDir(dir);
				cleanupDir(configHome);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"records.redact origin.actor omits actor from config, env, and identity-file sources",
		async () => {
			async function assertRedaction(opts: {
				configToml: string;
				extraEnv: Record<string, string | undefined>;
				identityActor?: string;
			}): Promise<void> {
				const dir = makeTmpDir();
				const configHome = makeTmpDir();
				try {
					const { planPath } = setupProject(dir);
					writeFileSync(join(dir, "5x.toml"), opts.configToml);
					git(["add", "5x.toml"], dir);
					git(["commit", "-m", "config"], dir);
					writeIdentity(configHome, {
						actor: opts.identityActor,
					});
					const extraEnv = {
						FIVEX_CONFIG_HOME: configHome,
						...opts.extraEnv,
					};
					const init = await run5x(dir, ["run", "init", "--plan", planPath], {
						extraEnv,
					});
					expect(init.exitCode).toBe(0);
					const runId = (
						JSON.parse(init.stdout) as { data: { run_id: string } }
					).data.run_id;

					await run5x(
						dir,
						[
							"run",
							"record",
							"author:impl:status",
							"--run",
							runId,
							"--result",
							'{"ok":true}',
							"--phase",
							"1",
						],
						{ extraEnv },
					);
					const prompt = await run5x(
						dir,
						[
							"prompt",
							"confirm",
							"Continue?",
							"--default",
							"yes",
							"--run",
							runId,
						],
						{ extraEnv },
					);
					expect(prompt.exitCode).toBe(0);

					const runJson = JSON.parse(
						readFileSync(join(runDir(dir, runId), "run.json"), "utf-8"),
					) as { creator?: { actor?: string; installation_id?: string } };
					assertRedactedRecorder(runJson.creator);

					const step = readJsonl(join(runDir(dir, runId), "steps.jsonl"))[0];
					const origin = step?.origin as {
						recorder?: { actor?: string; installation_id?: string };
						performer?: { kind?: string };
					};
					assertRedactedRecorder(origin.recorder);
					expect(origin.performer?.kind).toBe("system");

					const decision = readJsonl(
						join(runDir(dir, runId), "decisions.jsonl"),
					)[0];
					const decisionOrigin = decision?.origin as {
						recorder?: { actor?: string; installation_id?: string };
						performer?: { kind?: string };
					};
					assertRedactedRecorder(decisionOrigin?.recorder);
					expect(decisionOrigin?.performer?.kind).toBe("human");

					const store = createMemoryRecordStore();
					store.putRun({
						id: runId,
						plan_path: planPath,
						config_json: null,
						created_at: "2026-01-01 00:00:00",
						sealed_at: null,
						status: "active",
						final_head_commit: null,
						cli_version: "1.0.0",
						format_version: RUN_RECORD_FORMAT_VERSION,
						creator: {
							installation_id: origin.recorder?.installation_id ?? "",
						},
					});
					const performer: RecordPerformer = {
						kind: "agent",
						role: "reviewer",
						provider: "opencode",
					};
					const envelope = recordedEnvelope({
						recorder: {
							installation_id: origin.recorder?.installation_id ?? "",
						},
						performer,
					});
					store.atomicAppend([
						{
							runId,
							stream: "steps",
							idempotencyKey: stepIdempotencyKey({
								runId,
								stepName: "reviewer:plan",
								phase: "1",
								iteration: 1,
							}),
							payload: { step_name: "reviewer:plan" },
							...envelope,
						},
						{
							runId,
							stream: "budget",
							idempotencyKey: "budget:snapshot:1",
							payload: { remaining: 3 },
							...envelope,
						},
					]);
					const paired = store.listLines(runId, "budget")[0];
					expect(paired?.origin).toEqual(
						store.listLines(runId, "steps")[0]?.origin,
					);
					expect(paired?.origin?.recorder.actor).toBeUndefined();
					expect(paired?.origin?.performer.kind).toBe("agent");
				} finally {
					cleanupDir(dir);
					cleanupDir(configHome);
				}
			}

			await assertRedaction({
				configToml: `[records]\nredact = ["origin.actor"]\nactor = "config-actor"\n`,
				extraEnv: {},
			});
			await assertRedaction({
				configToml: `[records]\nredact = ["origin.actor"]\n`,
				extraEnv: { FIVEX_RECORDS_ACTOR: "env-actor" },
			});
			await assertRedaction({
				configToml: `[records]\nredact = ["origin.actor"]\n`,
				extraEnv: {},
				identityActor: "identity-actor",
			});
		},
		{ timeout: 60000 },
	);
});
