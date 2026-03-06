/**
 * NDJSON Log Writer — writes AgentEvent objects to newline-delimited JSON files.
 *
 * Phase 11 consolidation: This module centralizes the NDJSON logging logic
 * that was previously embedded in invoke.ts and opencode.ts.
 *
 * The log writer:
 * - Creates log directories with appropriate permissions (0o700)
 * - Computes sequence numbers for log file naming
 * - Appends timestamped AgentEvent objects as JSON lines
 * - Supports both synchronous and asynchronous writing
 */

import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for log writing. */
export interface LogWriterOptions {
	/** Timestamp function (defaults to ISO string). */
	getTimestamp?: () => string;
}

/** Log entry with timestamp. */
export interface LogEntry {
	ts: string;
	type: AgentEvent["type"];
	// Other fields from AgentEvent spread here
	[key: string]: unknown;
}

/**
 * Log-only metadata written by the CLI invoke handler, NOT emitted by providers.
 * Written as the first NDJSON line in each log file to make logs self-describing.
 */
export interface SessionStartEntry {
	type: "session_start";
	role: string;
	template: string;
	run: string;
	phase_number?: string;
}

// ---------------------------------------------------------------------------
// Log Path Management
// ---------------------------------------------------------------------------

/**
 * Create the log directory and return the log file path.
 *
 * @param logDir - Full path to the log directory (e.g., `.5x/logs/run_abc123`)
 * @returns Path to the log file (e.g., `.5x/logs/run_abc123/agent-001.ndjson`)
 */
export function prepareLogPath(logDir: string): string {
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	const seq = nextLogSequence(logDir);
	return join(logDir, `agent-${seq}.ndjson`);
}

/**
 * Compute the next log sequence number from existing files in the directory.
 * Files are named `agent-XXX.ndjson` where XXX is a zero-padded number.
 *
 * @param logDir - Directory containing log files
 * @returns Next sequence number as zero-padded string (e.g., "001", "042")
 */
export function nextLogSequence(logDir: string): string {
	let max = 0;
	try {
		const files = readdirSync(logDir);
		for (const f of files) {
			// Match any number of digits to handle old/manual logs (e.g., agent-1.ndjson)
			const match = f.match(/^agent-(\d+)\.ndjson$/);
			if (match?.[1]) {
				const n = Number.parseInt(match[1], 10);
				if (n > max) max = n;
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable — start at 0
	}
	return String(max + 1).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// Log Writing
// ---------------------------------------------------------------------------

/**
 * Write a session_start metadata line to an NDJSON log file.
 * Should be called once, before any AgentEvent lines.
 */
export function appendSessionStart(
	logPath: string,
	entry: SessionStartEntry,
	opts?: LogWriterOptions,
): void {
	const timestamp = opts?.getTimestamp
		? opts.getTimestamp()
		: new Date().toISOString();
	const line = JSON.stringify({ ts: timestamp, ...entry });
	appendFileSync(logPath, `${line}\n`);
}

/**
 * Write an AgentEvent as a JSON line to an NDJSON log file.
 *
 * @param logPath - Path to the log file
 * @param event - AgentEvent to log
 * @param opts - Optional configuration
 */
export function appendLogLine(
	logPath: string,
	event: AgentEvent,
	opts?: LogWriterOptions,
): void {
	const timestamp = opts?.getTimestamp
		? opts.getTimestamp()
		: new Date().toISOString();
	const entry: LogEntry = {
		ts: timestamp,
		...event,
	};
	const line = JSON.stringify(entry);
	appendFileSync(logPath, `${line}\n`);
}

/**
 * Create a log writer bound to a specific log file.
 * Returns a function that appends events to that file.
 *
 * @param logPath - Path to the log file
 * @param opts - Optional configuration
 * @returns Function to append events
 */
export function createLogWriter(
	logPath: string,
	opts?: LogWriterOptions,
): (event: AgentEvent) => void {
	return (event: AgentEvent) => appendLogLine(logPath, event, opts);
}

/**
 * Create a log writer that writes to an array (for testing/debugging).
 *
 * @param buffer - Array to append entries to
 * @param opts - Optional configuration
 * @returns Function to append events to the buffer
 */
export function createBufferLogWriter(
	buffer: LogEntry[],
	opts?: LogWriterOptions,
): (event: AgentEvent) => void {
	return (event: AgentEvent) => {
		const timestamp = opts?.getTimestamp
			? opts.getTimestamp()
			: new Date().toISOString();
		buffer.push({
			ts: timestamp,
			...event,
		});
	};
}

// ---------------------------------------------------------------------------
// Batch Operations
// ---------------------------------------------------------------------------

/**
 * Write multiple AgentEvents to a log file.
 *
 * @param logPath - Path to the log file
 * @param events - Array of events to log
 * @param opts - Optional configuration
 */
export function appendLogLines(
	logPath: string,
	events: AgentEvent[],
	opts?: LogWriterOptions,
): void {
	const getTimestamp = opts?.getTimestamp ?? (() => new Date().toISOString());
	const lines = events.map((event) => {
		const entry: LogEntry = {
			ts: getTimestamp(),
			...event,
		};
		return JSON.stringify(entry);
	});
	appendFileSync(logPath, `${lines.join("\n")}\n`);
}
