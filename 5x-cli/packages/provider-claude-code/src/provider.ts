/**
 * Claude Code `AgentProvider` — session lifecycle and subprocess tracking.
 */

import type {
	AgentProvider,
	AgentSession,
	ResumeOptions,
	SessionOptions,
} from "@5x-ai/5x-cli";

import { parseModelForClaudeCode } from "./model.js";
import {
	ClaudeCodeSession,
	forceKillSubprocess,
	type ClaudeCodeExecutionHost,
	type ClaudeCodeSessionOptions,
	type ClaudeSubprocess,
} from "./session.js";
import type { ClaudeCodeConfig } from "./types.js";

/** Fallback model when `resumeSession` is called without `opts.model`. */
const RESUME_MODEL_DEFAULT = "sonnet";

export class ClaudeCodeProvider implements AgentProvider, ClaudeCodeExecutionHost {
	private config: ClaudeCodeConfig;
	private sessions = new Map<string, ClaudeCodeSession>();
	private processes = new Set<ClaudeSubprocess>();
	private _closed = false;

	constructor(config: ClaudeCodeConfig) {
		this.config = config;
	}

	get isClosed(): boolean {
		return this._closed;
	}

	trackProcess(proc: ClaudeSubprocess): void {
		this.processes.add(proc);
	}

	untrackProcess(proc: ClaudeSubprocess): void {
		this.processes.delete(proc);
	}

	async startSession(opts: SessionOptions): Promise<AgentSession> {
		if (this._closed) throw new Error("Provider is closed");
		const id = crypto.randomUUID();
		const sessionOpts: ClaudeCodeSessionOptions = {
			id,
			firstInvocationMode: "session-id",
			model: parseModelForClaudeCode(opts.model),
			cwd: opts.workingDirectory,
			config: this.config,
			provider: this,
		};
		const session = new ClaudeCodeSession(sessionOpts);
		this.sessions.set(id, session);
		return session;
	}

	async resumeSession(
		sessionId: string,
		opts?: ResumeOptions,
	): Promise<AgentSession> {
		if (this._closed) throw new Error("Provider is closed");
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;

		// New resume handle: cwd comes from ResumeOptions, else `process.cwd()` (CLI must pass
		// `workingDirectory` when resuming if it differs from the subprocess workspace).
		const cwd = opts?.workingDirectory ?? process.cwd();

		const sessionOpts: ClaudeCodeSessionOptions = {
			id: sessionId,
			firstInvocationMode: "resume",
			model: parseModelForClaudeCode(opts?.model ?? RESUME_MODEL_DEFAULT),
			cwd,
			config: this.config,
			provider: this,
		};
		const session = new ClaudeCodeSession(sessionOpts);
		this.sessions.set(sessionId, session);
		return session;
	}

	async close(): Promise<void> {
		if (this._closed) return;
		this._closed = true;
		for (const proc of [...this.processes]) {
			await forceKillSubprocess(proc);
		}
		this.processes.clear();
		this.sessions.clear();
	}
}
