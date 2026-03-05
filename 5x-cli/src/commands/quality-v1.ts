/**
 * v1 Quality gate command.
 *
 * `5x quality run`
 *
 * Reads `qualityGates` from config, executes each sequentially,
 * and returns a JSON envelope with pass/fail results.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
import { runQualityGates } from "../gates/quality.js";
import { outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";

const runCmd = defineCommand({
	meta: {
		name: "run",
		description: "Execute configured quality gates",
	},
	args: {},
	async run() {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const commands = config.qualityGates;
		if (commands.length === 0) {
			outputSuccess({
				passed: true,
				results: [],
			});
			return;
		}

		// Use a temporary run context for logging purposes
		const runId = `quality-${Date.now()}`;
		const logDir = join(projectRoot, ".5x", "logs", runId);
		mkdirSync(logDir, { recursive: true, mode: 0o700 });

		const result = await runQualityGates(commands, projectRoot, {
			runId,
			logDir,
			phase: "0",
			attempt: 1,
		});

		outputSuccess({
			passed: result.passed,
			results: result.results.map((r) => ({
				command: r.command,
				passed: r.passed,
				duration_ms: Math.round(r.duration),
				output: r.output,
			})),
		});
	},
});

export default defineCommand({
	meta: {
		name: "quality",
		description: "Quality gate operations",
	},
	subCommands: {
		run: () => Promise.resolve(runCmd),
	},
});
