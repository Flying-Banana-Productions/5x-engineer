import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const EXAMPLE = resolve(
	import.meta.dir,
	"../../examples/author-review-loop.sh",
);
const hasShellTools = Boolean(Bun.which("bash") && Bun.which("jq"));

// Exercise the shell orchestrator without paid provider calls. The fake CLI
// supplies recorded outcomes; Git/path checks still use a real temporary repo.
const FAKE_CLI = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (!args.includes("--json")) throw new Error("must override text output");
const scenario = process.env.EXAMPLE_SCENARIO;
const count = () => {
  try { return Number(readFileSync("reviews", "utf8")); } catch { return 0; }
};
let data = {};
const key = args.slice(0, 2).join(" ");
if (key === "config show") {
  data = { entries: [
    { key: "author.delegationMode", value: "invoke" },
    { key: "reviewer.delegationMode", value: "invoke" },
    { key: "maxReviewIterations", value: 3 },
  ] };
} else if (key === "plan phases") {
  data = { phases: [{ id: "1", done: count() > 0 }] };
  if (scenario === "more-phases") data.phases.push({ id: "2", done: false });
} else if (key === "run init") {
  data = { run_id: "run_example", resumed: scenario === "resumed",
    warnings: ["Example freshness warning"], harness_freshness: [{ status: "stale" }] };
} else if (key === "invoke author") {
  data = { step_name: "author:" + args[2], result: { result: "complete", commit: "abc123" } };
} else if (key === "phase finish" && scenario === "quality-fails") {
  console.log(JSON.stringify({ ok: false, error: { code: "QUALITY_FAILED" } }));
  process.exit(1);
} else if (key === "template render") {
  data = { variables: { review_path: process.cwd() + "/review.md" } };
} else if (key === "invoke reviewer") {
  const round = count() + 1;
  writeFileSync("reviews", String(round));
  data = { pinned_mode: "advisory", result: { readiness: "ready", items: [] } };
  if (scenario === "fix" && round === 1) {
    data.result = { readiness: "not_ready", items: [{ action: "auto_fix" }] };
  }
  if (scenario === "gate" || scenario === "correction") {
    data = { pinned_mode: "enforced", result: { readiness: "ready", items: [],
      governance: { route: scenario === "gate" ? "human_gate" : "final_corrections" } } };
  }
  if (scenario === "record-fails") {
    console.log(JSON.stringify({ ok: true, data }));
    console.error("Failed to record reviewer result");
    process.exit(1);
  }
} else if (key === "run state") {
  data = { run: { worktree_path: process.cwd() } };
}
console.log(JSON.stringify({ ok: true, data }));
`;

async function exercise(scenario: string) {
	const tmp = mkdtempSync(join(tmpdir(), "5x-example-"));
	try {
		writeFileSync(join(tmp, "mock.ts"), FAKE_CLI);
		writeFileSync(
			join(tmp, "5x"),
			`#!/bin/sh\nexec "${process.execPath}" "${join(tmp, "mock.ts")}" "$@"\n`,
		);
		chmodSync(join(tmp, "5x"), 0o755);
		writeFileSync(join(tmp, "plan.md"), "# Example\n");
		writeFileSync(join(tmp, "review.md"), "# Review\n");
		const env = {
			...cleanGitEnv(),
			PATH: `${tmp}:${process.env.PATH}`,
			FIVEX_OUTPUT_FORMAT: "text",
			EXAMPLE_SCENARIO: scenario,
		};
		const git = Bun.spawnSync(["git", "init", "-q"], {
			cwd: tmp,
			env,
			stdin: "ignore",
		});
		expect(git.exitCode).toBe(0);
		const proc = Bun.spawn(["bash", EXAMPLE, "plan.md"], {
			cwd: tmp,
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
		const calls = readFileSync(join(tmp, "calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		return { stdout, stderr, exitCode, calls };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function isCall(call: string[], first: string, second: string) {
	return call[0] === first && call[1] === second;
}

describe.skipIf(!hasShellTools)("author-review shell example", () => {
	test(
		"runs fresh quality after fixes, reviews again, and completes only afterwards",
		async () => {
			const result = await exercise("fix");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Example freshness warning");
			const workflow = result.calls.filter(
				(call) => call[0] === "invoke" || isCall(call, "phase", "finish"),
			);
			expect(workflow.map((call) => call.slice(0, 2).join(" "))).toEqual([
				"invoke author",
				"phase finish",
				"invoke reviewer",
				"invoke author",
				"phase finish",
				"invoke reviewer",
			]);
			expect(workflow[3]?.[2]).toBe("author-process-impl-review");
			const quality = workflow.filter((call) =>
				isCall(call, "phase", "finish"),
			);
			expect(
				quality.map((call) => call[call.indexOf("--iteration") + 1]),
			).toEqual(["1", "2"]);
			expect(result.calls.at(-1)?.slice(0, 2)).toEqual(["run", "complete"]);
		},
		{ timeout: 15000 },
	);

	test(
		"checkpoints and leaves a multi-phase run active",
		async () => {
			const result = await exercise("more-phases");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("remains active");
			expect(result.calls.some((call) => isCall(call, "run", "complete"))).toBe(
				false,
			);
			expect(result.calls.at(-1)).toContain("--no-record");
		},
		{ timeout: 15000 },
	);

	for (const scenario of [
		"gate",
		"correction",
		"quality-fails",
		"record-fails",
		"resumed",
	]) {
		test(
			`hands off without false completion: ${scenario}`,
			async () => {
				const result = await exercise(scenario);
				expect(result.exitCode).not.toBe(0);
				expect(
					result.calls.some((call) => isCall(call, "run", "complete")),
				).toBe(false);
				expect(result.calls.some((call) => isCall(call, "run", "record"))).toBe(
					false,
				);
				expect(result.calls.at(-1)).toContain("--no-record");
				if (scenario === "quality-fails") {
					expect(result.stderr).toContain("QUALITY_FAILED");
					expect(
						result.calls.some((call) => isCall(call, "invoke", "reviewer")),
					).toBe(false);
				}
				if (scenario === "record-fails") {
					expect(result.stderr).toContain("Failed to record reviewer result");
				}
				if (scenario === "resumed") {
					expect(result.calls.some((call) => call[0] === "invoke")).toBe(false);
				}
			},
			{ timeout: 15000 },
		);
	}
});
