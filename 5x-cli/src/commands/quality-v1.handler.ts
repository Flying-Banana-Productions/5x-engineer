/**
 * Quality gate command handler — business logic for quality gate execution.
 *
 * Framework-independent: no citty imports.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runQualityGates } from "../gates/quality.js";
import { outputSuccess } from "../output.js";
import { resolveProjectContext } from "./context.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runQuality(): Promise<void> {
	const { projectRoot, config } = await resolveProjectContext();

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
}
