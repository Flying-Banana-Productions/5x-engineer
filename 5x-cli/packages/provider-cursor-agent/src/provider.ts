/**
 * Cursor Agent `AgentProvider` — session lifecycle and subprocess tracking.
 */

import type {
	AgentProvider,
	AgentSession,
	ResumeOptions,
	SessionOptions,
} from "@5x-ai/5x-cli";

import {
	createCursorChatSessionId,
	CursorAgentSession,
	forceKillSubprocess,
	type CursorAgentExecutionHost,
	type CursorAgentSessionOptions,
	type CursorAgentSubprocess,
} from "./session.js";
import type { CursorAgentConfig } from "./types.js";

export class CursorAgentProvider implements AgentProvider, CursorAgentExecutionHost {
	private config: CursorAgentConfig;
	private sessions = new Map<string, CursorAgentSession>();
	private processes = new Set<CursorAgentSubprocess>();
	private _closed = false;

	constructor(config: CursorAgentConfig) {
		this.config = config;
	}

	get isClosed(): boolean {
		return this._closed;
	}

	trackProcess(proc: CursorAgentSubprocess): void {
		this.processes.add(proc);
	}

	untrackProcess(proc: CursorAgentSubprocess): void {
		this.processes.delete(proc);
	}

	private sessionOptions(
		id: string,
		model: string | undefined,
		cwd: string,
	): CursorAgentSessionOptions {
		return {
			id,
			model: model !== "" ? model : undefined,
			cwd,
			config: this.config,
			provider: this,
		};
	}

	async startSession(opts: SessionOptions): Promise<AgentSession> {
		if (this._closed) throw new Error("Provider is closed");

		const binary = this.config.agentBinary ?? "agent";
		const sessionId = await createCursorChatSessionId(
			binary,
			opts.workingDirectory,
			this.config,
			this,
		);

		const session = new CursorAgentSession(
			this.sessionOptions(sessionId, opts.model, opts.workingDirectory),
		);
		this.sessions.set(sessionId, session);
		return session;
	}

	async resumeSession(
		sessionId: string,
		opts?: ResumeOptions,
	): Promise<AgentSession> {
		if (this._closed) throw new Error("Provider is closed");

		const existing = this.sessions.get(sessionId);
		if (existing) return existing;

		const cwd = opts?.workingDirectory ?? process.cwd();
		const session = new CursorAgentSession(
			this.sessionOptions(sessionId, opts?.model, cwd),
		);
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
