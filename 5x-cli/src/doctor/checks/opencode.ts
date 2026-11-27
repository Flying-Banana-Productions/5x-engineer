/**
 * Doctor check: installed OpenCode binary version (detect-only).
 *
 * Applies when a role resolves to the `opencode` provider, or an OpenCode
 * harness manifest exists at project or user scope. Runs `opencode --version`
 * and reports `opencode-missing` when the binary cannot be spawned, or
 * `opencode-outdated` when it is older than `MIN_OPENCODE_VERSION`. Reports
 * nothing otherwise (not applicable, current, or an unreadable version).
 *
 * Findings are `warn`: the provider's own version gate is the hard stop, and
 * the default provider is `opencode`, so a missing binary on a project that
 * never invokes OpenCode must not fail `5x doctor`.
 */

import { existsSync } from "node:fs";
import { resolveLayeredConfig } from "../../config.js";
import { opencodeLocationResolver } from "../../harnesses/locations.js";
import { manifestPath } from "../../harnesses/manifest.js";
import {
	compareVersions,
	MIN_OPENCODE_VERSION,
	parseOpenCodeVersion,
} from "../../providers/opencode.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
} from "../types.js";

export const OPENCODE_CHECK_ID = "opencode";
export const OPENCODE_MISSING = "opencode-missing";
export const OPENCODE_OUTDATED = "opencode-outdated";

/** Bound on `opencode --version`. */
export const OPENCODE_VERSION_TIMEOUT_MS = 5_000;

/** Outcome of running `opencode --version`. */
export type OpenCodeVersionResult =
	| { kind: "missing" }
	| { kind: "output"; stdout: string; stderr: string; exitCode: number }
	| { kind: "error"; message: string };

export type OpenCodeVersionRunner = () => Promise<OpenCodeVersionResult>;

function isSpawnNotFound(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: unknown; message?: unknown };
	if (e.code === "ENOENT") return true;
	return (
		typeof e.message === "string" &&
		/ENOENT|not found|no such file/i.test(e.message)
	);
}

/** Default runner: `opencode --version`, stdin ignored, bounded at 5 s. */
export const runOpenCodeVersion: OpenCodeVersionRunner = async () => {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["opencode", "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		if (isSpawnNotFound(err)) return { kind: "missing" };
		return {
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timeout">((resolveTimeout) => {
		timer = setTimeout(
			() => resolveTimeout("timeout"),
			OPENCODE_VERSION_TIMEOUT_MS,
		);
	});
	try {
		const completed = Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
			proc.exited,
		]);
		const outcome = await Promise.race([completed, timedOut]);
		if (outcome === "timeout") {
			proc.kill("SIGKILL");
			return {
				kind: "error",
				message: `opencode --version did not exit within ${OPENCODE_VERSION_TIMEOUT_MS} ms`,
			};
		}
		const [stdout, stderr, exitCode] = outcome;
		return { kind: "output", stdout, stderr, exitCode };
	} finally {
		if (timer) clearTimeout(timer);
	}
};

/**
 * Extract the first `major.minor.patch` token from `opencode --version`
 * output. 1.x prints a bare `1.2.3`; 2.x prints `opencode v2.4.2`.
 */
export function parseOpenCodeVersionOutput(output: string): string | undefined {
	const match = /(?:^|[^\w.])v?(\d+\.\d+\.\d+)/.exec(output);
	if (!match?.[1]) return undefined;
	return parseOpenCodeVersion(match[1]) ? match[1] : undefined;
}

/** Why the check applies; empty when it does not. */
async function applicabilityReasons(
	ctx: DoctorCheckContext,
): Promise<string[]> {
	const reasons: string[] = [];
	try {
		const { config } = await resolveLayeredConfig(
			ctx.projectRoot,
			ctx.startDir,
			() => {},
		);
		if (config.author.provider === "opencode") reasons.push("author.provider");
		if (config.reviewer.provider === "opencode") {
			reasons.push("reviewer.provider");
		}
	} catch {
		// An unloadable config establishes no provider; manifests still apply.
	}
	for (const scope of ["project", "user"] as const) {
		const { rootDir } = opencodeLocationResolver.resolve(
			scope,
			ctx.projectRoot,
			ctx.homeDir,
		);
		if (existsSync(manifestPath(rootDir))) reasons.push(`harness:${scope}`);
	}
	return reasons;
}

export interface OpenCodeCheckDeps {
	runVersion?: OpenCodeVersionRunner;
}

export function createOpencodeCheck(deps: OpenCodeCheckDeps = {}): DoctorCheck {
	const runVersion = deps.runVersion ?? runOpenCodeVersion;

	async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
		const appliesBecause = await applicabilityReasons(ctx);
		if (appliesBecause.length === 0) return [];

		const result = await runVersion();
		if (result.kind === "missing") {
			return [
				{
					check: OPENCODE_CHECK_ID,
					status: "warn",
					code: OPENCODE_MISSING,
					message: `opencode binary not found on PATH; 5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION}`,
					remediation:
						"install OpenCode 2.x (https://opencode.ai) and put `opencode` on PATH",
					fixable: false,
					detail: { minimum: MIN_OPENCODE_VERSION, appliesBecause },
				},
			];
		}
		if (result.kind !== "output") return [];

		const found = parseOpenCodeVersionOutput(
			`${result.stdout}\n${result.stderr}`,
		);
		const parsed = found ? parseOpenCodeVersion(found) : undefined;
		const minimum = parseOpenCodeVersion(MIN_OPENCODE_VERSION);
		if (!found || !parsed || !minimum) return [];
		if (compareVersions(parsed, minimum) >= 0) return [];

		const oneX = parsed[0] < 2;
		return [
			{
				check: OPENCODE_CHECK_ID,
				status: "warn",
				code: OPENCODE_OUTDATED,
				message: `5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION} (found ${found})`,
				remediation: oneX ? "opencode upgrade --major" : "opencode upgrade",
				fixable: false,
				detail: { found, minimum: MIN_OPENCODE_VERSION, appliesBecause },
			},
		];
	}

	return { id: OPENCODE_CHECK_ID, run };
}

export const opencodeCheck: DoctorCheck = createOpencodeCheck();
