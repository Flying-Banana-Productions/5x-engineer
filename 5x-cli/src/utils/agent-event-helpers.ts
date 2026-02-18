/**
 * Shared helpers for agent event formatting and escalation message building.
 *
 * Centralised here to eliminate copy-paste between phase-execution-loop.ts and
 * plan-review-loop.ts, which previously duplicated outputSnippet(),
 * buildEscalationReason(), and makeOnEvent() identically.
 */

import type { AgentResult } from "../agents/types.js";
import { formatNdjsonEvent } from "./ndjson-formatter.js";

/**
 * Build a short output snippet from an agent result for escalation messages.
 * Derived from result.output (final result text) and optionally result.error
 * (stderr). Never raw NDJSON event lines.
 */
export function outputSnippet(result: AgentResult): string {
	const parts: string[] = [];
	if (result.error) {
		parts.push(`stderr: ${result.error.slice(0, 200)}`);
	}
	const text = (result.output ?? "").slice(0, 500);
	if (text) parts.push(text);
	return parts.join("\n").slice(0, 500);
}

/**
 * Build an escalation reason string that always includes the NDJSON log path
 * and conditionally includes an output snippet (quiet mode only).
 *
 * In non-quiet mode the user has already watched the streaming output, so the
 * snippet is omitted — the log path is still included for copy-paste access.
 */
export function buildEscalationReason(
	base: string,
	logPath: string,
	result: AgentResult,
	quiet: boolean,
): string {
	const pathLine = `Log: ${logPath}`;
	if (quiet) {
		const snippet = outputSnippet(result);
		return snippet
			? `${base}\n${pathLine}\n${snippet}`
			: `${base}\n${pathLine}`;
	}
	return `${base}\n${pathLine}`;
}

/**
 * Build an onEvent handler that formats NDJSON events to stdout.
 * Returns undefined when quiet is true (suppresses all agent console output).
 */
export function makeOnEvent(
	quiet: boolean,
): ((event: unknown, _rawLine: string) => void) | undefined {
	if (quiet) return undefined;
	return (event: unknown) => {
		const line = formatNdjsonEvent(event);
		if (line != null) process.stdout.write(`${line}\n`);
	};
}
