/**
 * Cursor Agent provider — Phase 2 implements session lifecycle.
 */

import type {
	AgentProvider,
	AgentSession,
	ResumeOptions,
	SessionOptions,
} from "@5x-ai/5x-cli";

import type { CursorAgentConfig } from "./types.js";

const NOT_IMPLEMENTED =
	"Cursor Agent provider session lifecycle is not implemented yet";

export class CursorAgentProvider implements AgentProvider {
	constructor(private readonly _config: CursorAgentConfig) {}

	startSession(_opts: SessionOptions): Promise<AgentSession> {
		return Promise.reject(new Error(NOT_IMPLEMENTED));
	}

	resumeSession(_sessionId: string, _opts?: ResumeOptions): Promise<AgentSession> {
		return Promise.reject(new Error(NOT_IMPLEMENTED));
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}
