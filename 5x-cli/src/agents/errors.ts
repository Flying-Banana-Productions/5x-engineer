export class AgentTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentTimeoutError";
	}
}

export class AgentCancellationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentCancellationError";
	}
}

export function isAgentCancellationError(err: unknown): boolean {
	return err instanceof AgentCancellationError;
}
