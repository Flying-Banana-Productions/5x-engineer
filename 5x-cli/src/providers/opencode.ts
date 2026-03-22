/**
 * OpenCode provider — v1 AgentProvider implementation using @opencode-ai/sdk.
 *
 * Supports two modes:
 * - Managed: spawns a local OpenCode server via `createOpencode()`
 * - External: connects to an already-running server via `createOpencodeClient()`
 *
 * Ports core invocation logic from `src/agents/opencode.ts:481-1130` with
 * the simplified v1 provider interface.
 */

import {
	createOpencode,
	createOpencodeClient,
	type Event as OpenCodeEvent,
	type OpencodeClient,
	type OutputFormat,
} from "@opencode-ai/sdk/v2";

import { isStructuredOutputError } from "../protocol.js";
import {
	createEventMapperState,
	mapSseToAgentEvent,
	resolveSessionIdWithContext,
	type SessionResolveContext,
} from "./event-mapper.js";
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	JSONSchema,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error classes (ported from src/agents/errors.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a "provider/model" string into the SDK's model object.
 */
export function parseModel(model: string): {
	providerID: string;
	modelID: string;
} {
	const slashIdx = model.indexOf("/");
	if (slashIdx < 1) {
		throw new Error(
			`Invalid model format "${model}" — expected "provider/model" (e.g. "anthropic/claude-sonnet-4-6")`,
		);
	}
	return {
		providerID: model.slice(0, slashIdx),
		modelID: model.slice(slashIdx + 1),
	};
}

function isAbortLikeError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError") return true;
	return err.message.toLowerCase().includes("aborted");
}

async function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	if (signal.aborted) {
		throw new AgentCancellationError("Agent invocation cancelled");
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		(timer as { unref?: () => void }).unref?.();

		const onAbort = () => {
			clearTimeout(timer);
			reject(new AgentCancellationError("Agent invocation cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Portable fallback for `AbortSignal.any()`.
 * Uses native `AbortSignal.any` when available, otherwise fans-in manually.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
	if (signals.length === 0) {
		return new AbortController().signal; // never-aborted signal
	}
	if (signals.length === 1) {
		// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
		return signals[0]!;
	}

	// Use native if available
	if (typeof AbortSignal.any === "function") {
		return AbortSignal.any(signals);
	}

	// Manual fan-in fallback
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}
	return controller.signal;
}

function buildStructuredSummaryPrompt(schema: JSONSchema): string {
	// Detect if this is a status or verdict schema from the presence of key fields
	const props = schema.properties as Record<string, unknown> | undefined;
	const isStatus = props && "result" in props && "commit" in props;

	if (isStatus) {
		return [
			"Do not call any other tools. Base your answer only on work already completed in this session.",
			"If result is complete, you MUST include the commit hash.",
			"If result is needs_human or failed, include a concise reason.",
		].join("\n");
	}

	return [
		"Summarize the current review outcome using the required JSON schema.",
		"Do not call tools. Base your answer only on evidence already gathered in this session.",
		"If readiness is not_ready or ready_with_corrections, include concrete items.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// SSE → AgentEvent mapping
// ---------------------------------------------------------------------------

// NOTE: Event mapping functions are imported from event-mapper.ts.
// This includes: getEventSessionId, resolveSessionIdWithContext, mapSseToAgentEvent

// ---------------------------------------------------------------------------
// OpenCode Session
// ---------------------------------------------------------------------------

class OpenCodeSession implements AgentSession {
	readonly id: string;

	constructor(
		private client: OpencodeClient,
		sessionId: string,
		private model: string | undefined,
		private workdir: string | undefined,
	) {
		this.id = sessionId;
	}

	async run(prompt: string, opts?: RunOptions): Promise<RunResult> {
		const start = Date.now();

		// Build cancellation signal
		const timeoutMs =
			opts?.timeout !== undefined ? opts.timeout * 1000 : undefined;
		const timeoutController =
			timeoutMs !== undefined ? new AbortController() : undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		if (timeoutController && timeoutMs !== undefined) {
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
			(timeoutId as { unref?: () => void }).unref?.();
		}

		const cancelSignals: AbortSignal[] = [];
		if (timeoutController) cancelSignals.push(timeoutController.signal);
		if (opts?.signal) cancelSignals.push(opts.signal);
		const cancelSignal =
			cancelSignals.length > 0 ? anySignal(cancelSignals) : undefined;

		try {
			// Phase 1: Execute prompt
			const executeResult = await this.sendPrompt(
				prompt,
				undefined,
				cancelSignal,
			);
			if (executeResult.error) {
				if (isStructuredOutputError(executeResult)) {
					throw new Error(
						`Structured output validation failed: ${JSON.stringify(executeResult.error)}`,
					);
				}
				throw new Error(
					`Agent invocation failed: ${JSON.stringify(executeResult.error)}`,
				);
			}

			// Phase 2: Structured output extraction (if schema provided)
			let structured: unknown;
			let text = this.extractText(executeResult);
			let info = executeResult.data?.info as
				| Record<string, unknown>
				| undefined;

			if (opts?.outputSchema) {
				const summaryFormat: OutputFormat = {
					type: "json_schema",
					schema: opts.outputSchema,
					retryCount: 2,
				};
				const summaryPrompt = buildStructuredSummaryPrompt(opts.outputSchema);
				const summaryResult = await this.sendPrompt(
					summaryPrompt,
					summaryFormat,
					cancelSignal,
				);

				if (summaryResult.error) {
					if (isStructuredOutputError(summaryResult)) {
						throw new Error(
							`Structured output validation failed: ${JSON.stringify(summaryResult.error)}`,
						);
					}
					throw new Error(
						`Agent invocation failed: ${JSON.stringify(summaryResult.error)}`,
					);
				}

				info = summaryResult.data?.info as Record<string, unknown> | undefined;
				structured = info?.structured;

				if (structured == null) {
					// Try recovery via polling
					const recovered = await this.waitForStructuredResult(cancelSignal);
					info = recovered.info as Record<string, unknown>;
					structured = info?.structured;

					if (structured == null) {
						if (info?.error && isStructuredOutputError({ error: info.error })) {
							throw new Error(
								`Structured output validation failed after retries: ${JSON.stringify(info.error)}`,
							);
						}
						throw new Error(
							"Agent did not return structured output — expected JSON schema response.",
						);
					}
				}

				text = this.extractText(summaryResult) || text;
			}

			const duration = Date.now() - start;
			const tokens = this.extractTokens(info);
			const costUsd = this.extractCost(info);

			return {
				text,
				structured,
				sessionId: this.id,
				tokens,
				costUsd,
				durationMs: duration,
			};
		} catch (err) {
			if (timeoutId !== undefined) clearTimeout(timeoutId);

			const isTimeout = timeoutController?.signal.aborted === true;
			const isExternalCancel = opts?.signal?.aborted === true;

			if (isTimeout || isExternalCancel) {
				try {
					await this.client.session.abort({ sessionID: this.id });
				} catch {
					// Ignore abort errors
				}
				if (isTimeout && !isExternalCancel) {
					throw new AgentTimeoutError(`Agent timed out after ${timeoutMs}ms`);
				}
				throw new AgentCancellationError("Agent invocation cancelled");
			}
			throw err;
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
		}
	}

	async *runStreamed(
		prompt: string,
		opts?: RunOptions,
	): AsyncIterable<AgentEvent> {
		const start = Date.now();

		// Build cancellation signal
		const timeoutMs =
			opts?.timeout !== undefined ? opts.timeout * 1000 : undefined;
		const timeoutController =
			timeoutMs !== undefined ? new AbortController() : undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const resetInactivityTimeout = () => {
			if (!timeoutController || timeoutMs === undefined) return;
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
		};
		if (timeoutController && timeoutMs !== undefined) {
			resetInactivityTimeout();
		}

		const cancelSignals: AbortSignal[] = [];
		if (timeoutController) cancelSignals.push(timeoutController.signal);
		if (opts?.signal) cancelSignals.push(opts.signal);
		const cancelSignal =
			cancelSignals.length > 0 ? anySignal(cancelSignals) : undefined;

		// SSE controller for the event stream
		const sseController = new AbortController();
		const propagateCancel = () => sseController.abort();
		cancelSignal?.addEventListener("abort", propagateCancel, { once: true });

		// Start SSE stream
		const sessionCtx: SessionResolveContext = {
			partToSession: new Map(),
			messageToSession: new Map(),
		};

		// Event mapper state for deduplication and part tracking
		const mapperState = createEventMapperState();

		let streamRef: AsyncIterable<OpenCodeEvent> | undefined;
		try {
			const { stream } = await this.client.event.subscribe(
				this.workdir ? { directory: this.workdir } : undefined,
				{ signal: sseController.signal },
			);
			streamRef = stream;
		} catch (err) {
			if (!sseController.signal.aborted) {
				yield {
					type: "error",
					message: `SSE subscription failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			return;
		}

		// Start the prompt in background
		const promptPromise = (async () => {
			// Phase 1: execute
			const executeResult = await this.sendPrompt(
				prompt,
				undefined,
				cancelSignal,
			);
			if (executeResult.error) {
				throw new Error(
					`Agent invocation failed: ${JSON.stringify(executeResult.error)}`,
				);
			}

			// Phase 2: structured output (if schema provided)
			if (opts?.outputSchema) {
				const summaryFormat: OutputFormat = {
					type: "json_schema",
					schema: opts.outputSchema,
					retryCount: 2,
				};
				const summaryPrompt = buildStructuredSummaryPrompt(opts.outputSchema);
				const summaryResult = await this.sendPrompt(
					summaryPrompt,
					summaryFormat,
					cancelSignal,
				);

				if (summaryResult.error) {
					throw new Error(
						`Agent invocation failed: ${JSON.stringify(summaryResult.error)}`,
					);
				}

				const info = summaryResult.data?.info as
					| Record<string, unknown>
					| undefined;
				let structured = info?.structured;

				if (structured == null) {
					const recovered = await this.waitForStructuredResult(cancelSignal);
					structured = (recovered.info as Record<string, unknown>)?.structured;
					if (structured == null) {
						throw new Error(
							"Agent did not return structured output — expected JSON schema response.",
						);
					}
				}

				return {
					text: this.extractText(executeResult),
					structured,
					info: summaryResult.data?.info as Record<string, unknown> | undefined,
				};
			}

			return {
				text: this.extractText(executeResult),
				structured: undefined,
				info: executeResult.data?.info as Record<string, unknown> | undefined,
			};
		})();

		// Stream SSE events while prompt runs
		let promptDone = false;
		let promptResult: Awaited<typeof promptPromise> | undefined;
		let promptError: unknown;

		// Mark prompt done when it completes
		promptPromise
			.then((r) => {
				promptResult = r;
				promptDone = true;
			})
			.catch((err) => {
				promptError = err;
				promptDone = true;
			})
			.finally(() => {
				// Stop SSE stream after prompt completes
				sseController.abort();
			});

		try {
			for await (const event of streamRef) {
				if (sseController.signal.aborted) break;

				// Filter to this session
				const eventSessionId = resolveSessionIdWithContext(event, sessionCtx);
				if (!eventSessionId || eventSessionId !== this.id) continue;

				// Reset inactivity timeout on activity
				resetInactivityTimeout();

				// Map to AgentEvent
				const agentEvent = mapSseToAgentEvent(event, mapperState);
				if (agentEvent) {
					yield agentEvent;
				}
			}
		} catch (err) {
			// Stream errors expected on abort
			if (!sseController.signal.aborted) {
				yield {
					type: "error",
					message: `SSE stream error: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			cancelSignal?.removeEventListener("abort", propagateCancel);
		}

		// Wait for prompt to finish if it hasn't
		if (!promptDone) {
			try {
				promptResult = await promptPromise;
			} catch (err) {
				promptError = err;
			}
		}

		if (promptError) {
			const isTimeout = timeoutController?.signal.aborted === true;
			const isExternalCancel = opts?.signal?.aborted === true;

			// Abort server-side session on timeout/cancel (best-effort, mirrors run())
			if (isTimeout || isExternalCancel) {
				try {
					await this.client.session.abort({ sessionID: this.id });
				} catch {
					// Swallow abort errors — best-effort cleanup
				}
			}

			if (isTimeout && !isExternalCancel) {
				yield {
					type: "error",
					message: `Agent timed out after ${timeoutMs}ms`,
				};
			} else if (isExternalCancel) {
				yield { type: "error", message: "Agent invocation cancelled" };
			} else {
				yield {
					type: "error",
					message:
						promptError instanceof Error
							? promptError.message
							: String(promptError),
				};
			}
			return;
		}

		if (promptResult) {
			const duration = Date.now() - start;
			const tokens = this.extractTokens(promptResult.info);
			const costUsd = this.extractCost(promptResult.info);

			const result: RunResult = {
				text: promptResult.text,
				structured: promptResult.structured,
				sessionId: this.id,
				tokens,
				costUsd,
				durationMs: duration,
			};

			yield { type: "usage", tokens, costUsd };
			yield { type: "done", result };
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private async sendPrompt(
		text: string,
		format: OutputFormat | undefined,
		cancelSignal: AbortSignal | undefined,
	) {
		const modelObj = this.model ? parseModel(this.model) : undefined;
		const promptPromise = this.client.session.prompt(
			{
				sessionID: this.id,
				parts: [{ type: "text", text }],
				...(format && { format }),
				...(modelObj && { model: modelObj }),
				...(this.workdir && { directory: this.workdir }),
			},
			cancelSignal ? { signal: cancelSignal } : undefined,
		);

		try {
			// Race against abort signal (same pattern as v0 _invoke).
			// Ensures cancellation works even if the SDK doesn't respect the signal.
			const result =
				cancelSignal !== undefined
					? await Promise.race([
							promptPromise,
							new Promise<never>((_, reject) => {
								if (cancelSignal.aborted) {
									reject(cancelSignal.reason ?? new Error("aborted"));
									return;
								}
								cancelSignal.addEventListener(
									"abort",
									() => reject(cancelSignal.reason ?? new Error("aborted")),
									{ once: true },
								);
							}),
						])
					: await promptPromise;
			return result;
		} catch (err) {
			const isCancel = cancelSignal?.aborted === true;
			if (!isCancel && isAbortLikeError(err)) {
				// Recoverable abort — poll for result
				return await this.waitForRecoveredPromptResult(false, cancelSignal);
			}
			throw err;
		}
	}

	private async waitForRecoveredPromptResult(
		requireStructured: boolean,
		signal?: AbortSignal,
	) {
		let stalledPolls = 0;

		while (true) {
			if (signal?.aborted) {
				throw new AgentCancellationError("Agent invocation cancelled");
			}

			const messages = await this.client.session.messages(
				{
					sessionID: this.id,
					...(this.workdir && { directory: this.workdir }),
					limit: 50,
				},
				signal ? { signal } : undefined,
			);

			if (!messages.error && Array.isArray(messages.data)) {
				const latestFirst = [...messages.data].reverse();
				let hasInFlightAssistant = false;

				for (const row of latestFirst) {
					const rowObj = row as Record<string, unknown>;
					const info = rowObj.info as Record<string, unknown> | undefined;
					if (!info || info.role !== "assistant") continue;

					const time = info.time as Record<string, unknown> | undefined;
					const completed = typeof time?.completed === "number";
					if (!completed) {
						hasInFlightAssistant = true;
						continue;
					}

					if (!requireStructured) {
						return {
							data: {
								info,
								parts: Array.isArray(rowObj.parts) ? rowObj.parts : [],
							},
							error: undefined,
						};
					}

					const structured = info.structured;
					if (structured != null) {
						return {
							data: {
								info,
								parts: Array.isArray(rowObj.parts) ? rowObj.parts : [],
							},
							error: undefined,
						};
					}

					if (info.error && isStructuredOutputError({ error: info.error })) {
						return {
							data: { info, parts: [] },
							error: undefined,
						};
					}
				}

				if (!hasInFlightAssistant) {
					stalledPolls += 1;
					if (stalledPolls >= 3) {
						throw new Error(
							requireStructured
								? "Agent did not return structured output — expected JSON schema response."
								: "Agent did not return a completed assistant message while recovering.",
						);
					}
				} else {
					stalledPolls = 0;
				}
			}

			await sleepWithSignal(500, signal);
		}
	}

	private async waitForStructuredResult(
		signal?: AbortSignal,
	): Promise<{ info: unknown }> {
		const result = await this.waitForRecoveredPromptResult(true, signal);
		return { info: result.data.info };
	}

	private extractText(result: unknown): string {
		const r = result as Record<string, unknown>;
		const data = r?.data as Record<string, unknown> | undefined;
		const parts = data?.parts as Array<unknown> | undefined;
		if (!parts) return "";

		const textParts = parts
			.map((p) => {
				const part = p as Record<string, unknown>;
				return part?.type === "text" && typeof part.text === "string"
					? part.text
					: "";
			})
			.filter((t) => t.length > 0);

		return textParts.join("\n");
	}

	private extractTokens(info: Record<string, unknown> | undefined): {
		in: number;
		out: number;
	} {
		const tokens = info?.tokens as Record<string, unknown> | undefined;
		return {
			in: typeof tokens?.input === "number" ? tokens.input : 0,
			out: typeof tokens?.output === "number" ? tokens.output : 0,
		};
	}

	private extractCost(
		info: Record<string, unknown> | undefined,
	): number | undefined {
		const cost = info?.cost;
		return typeof cost === "number" ? cost : undefined;
	}
}

// ---------------------------------------------------------------------------
// OpenCode Provider
// ---------------------------------------------------------------------------

export class OpenCodeProvider implements AgentProvider {
	private client: OpencodeClient;
	private server: { url: string; close(): void } | null;
	private defaultModel?: string;
	private closed = false;

	/** @internal Use static factory methods instead. */
	constructor(
		client: OpencodeClient,
		server: { url: string; close(): void } | null,
		defaultModel?: string,
	) {
		this.client = client;
		this.server = server;
		this.defaultModel = defaultModel;
	}

	/**
	 * Create a managed provider — spawns a local OpenCode server.
	 */
	static async createManaged(opts?: {
		model?: string;
	}): Promise<OpenCodeProvider> {
		try {
			const { client, server } = await createOpencode({
				hostname: "127.0.0.1",
				port: 0,
				timeout: 15_000,
			});
			return new OpenCodeProvider(client, server, opts?.model);
		} catch (err) {
			throw new Error(
				"OpenCode server failed to start — check that opencode is installed and on PATH. " +
					`Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Create an external provider — connects to an already-running OpenCode server.
	 */
	static createExternal(
		baseUrl: string,
		opts?: { model?: string },
	): OpenCodeProvider {
		const client = createOpencodeClient({ baseUrl });
		return new OpenCodeProvider(client, null, opts?.model);
	}

	/**
	 * The URL of the running OpenCode server.
	 */
	get serverUrl(): string {
		return this.server?.url ?? "(external)";
	}

	async startSession(opts: SessionOptions): Promise<AgentSession> {
		const model = opts.model ?? this.defaultModel;
		const title = `5x-session-${Date.now()}`;

		const sessionResult = await this.client.session.create({
			title,
			...(opts.workingDirectory && { directory: opts.workingDirectory }),
		});

		if (sessionResult.error) {
			throw new Error(
				`Failed to create session: ${JSON.stringify(sessionResult.error)}`,
			);
		}

		const sessionId = sessionResult.data.id;
		return new OpenCodeSession(
			this.client,
			sessionId,
			model,
			opts.workingDirectory,
		);
	}

	async resumeSession(
		sessionId: string,
		opts?: ResumeOptions,
	): Promise<AgentSession> {
		const result = await this.client.session.get({ sessionID: sessionId });
		if (result.error) {
			throw new Error(
				`Failed to resume session "${sessionId}": ${JSON.stringify(result.error)}`,
			);
		}

		// Extract workdir from session data
		const sessionData = result.data as Record<string, unknown>;
		const workdir =
			typeof sessionData.directory === "string"
				? sessionData.directory
				: undefined;

		// Model: use explicit override, then provider default
		const model = opts?.model ?? this.defaultModel;

		return new OpenCodeSession(this.client, sessionId, model, workdir);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.server?.close();
		} catch {
			// Ignore close errors — server may already be gone
		}
	}

	/**
	 * Health check — verify the server is reachable.
	 */
	async verify(): Promise<void> {
		try {
			const result = await this.client.session.list();
			if (result.error) {
				throw new Error(
					typeof result.error === "object"
						? JSON.stringify(result.error)
						: String(result.error),
				);
			}
		} catch (err) {
			throw new Error(
				"OpenCode server health check failed — server did not start correctly. " +
					`Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
