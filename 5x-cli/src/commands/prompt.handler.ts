/**
 * Prompt command handlers — persist-then-wait over PromptStore.
 *
 * Framework-independent: no CLI framework imports. Uses stdin utilities from
 * src/utils/stdin.ts and output helpers from src/output.ts.
 *
 * Prompt text is written via getPromptOutput() (stderr normally, /dev/tty
 * when stdin is piped but a terminal is available). JSON results always
 * go to stdout via outputSuccess/outputError.
 *
 * This file must not import bun:sqlite, getRunV1, resolveDbContext, or
 * prompt-context.ts. Production adapters inject resolveContext; unit tests
 * inject a memory store and fake runExists.
 */

import {
	type CliAbortCause,
	getCliAbortCause,
	getCliAbortSignal,
} from "../cli-lifecycle.js";
import type { PromptStore } from "../control-plane/store.js";
import type {
	AbandonReason,
	PromptKind,
	PromptRecord,
} from "../control-plane/types.js";
import {
	PROMPT_POLL_INTERVAL_MS,
	PromptAbandonedError,
	PromptTimeoutError,
	PromptWaitAbortedError,
	waitForPromptAnswer,
} from "../control-plane/wait.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { parseIntArg } from "../utils/parse-args.js";
import {
	ABORTED,
	readAll as defaultReadAll,
	readLine as defaultReadLine,
	readStdinPipe as defaultReadStdinPipe,
	isTTY as detectTTY,
	EOF,
	getPromptOutput,
	SIGINT,
} from "../utils/stdin.js";

// ---------------------------------------------------------------------------
// Prompt output helpers
// ---------------------------------------------------------------------------

/** Write a line to the prompt output stream (stderr or /dev/tty). */
function promptLine(text: string): void {
	getPromptOutput().write(`${text}\n`);
}

/** Write text without a trailing newline to the prompt output stream. */
function promptWrite(text: string): void {
	getPromptOutput().write(text);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromptCommandContext {
	store: PromptStore;
	/** True iff a `runs` row exists. Production closes over getRunV1(db). */
	runExists: (runId: string) => boolean;
}

export interface PromptHandlerDeps {
	store?: PromptStore;
	runExists?: (runId: string) => boolean;
	resolveContext?: () => Promise<PromptCommandContext>;
	isTTY?: () => boolean;
	readLine?: typeof defaultReadLine;
	readAll?: typeof defaultReadAll;
	readStdinPipe?: typeof defaultReadStdinPipe;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	getAbortSignal?: () => AbortSignal;
	getAbortCause?: () => CliAbortCause | undefined;
}

export interface ChooseParams {
	message: string;
	options: string;
	default?: string;
	run?: string;
	timeout?: number;
}

export interface ConfirmParams {
	message: string;
	default?: string;
	run?: string;
	timeout?: number;
}

export interface InputParams {
	message: string;
	multiline?: boolean;
	run?: string;
	timeout?: number;
}

// ---------------------------------------------------------------------------
// Internal race types
// ---------------------------------------------------------------------------

type InputRace =
	| { tag: "value"; value: string }
	| { tag: "eof" }
	| { tag: "sigint" }
	| { tag: "aborted" };

type PollRace =
	| { tag: "answered"; prompt: PromptRecord }
	| { tag: "timeout" }
	| { tag: "abandoned"; prompt: PromptRecord }
	| { tag: "poll-aborted" };

type RaceWinner =
	| { source: "input"; result: InputRace }
	| { source: "poll"; result: PollRace };

const NON_INTERACTIVE_MESSAGE =
	"Interactive prompt required but stdin is not a TTY (no --default provided)";

const EOF_MESSAGE = "End of input received with no valid selection";
const INTERRUPTED_MESSAGE = "Prompt interrupted by user";
const TERMINATED_MESSAGE = "Prompt terminated";
const TIMEOUT_MESSAGE = "Prompt timed out";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout < 0) {
			outputError("INVALID_ARGS", "--timeout must be a valid integer", {
				value: timeout,
			});
		}
		return timeout;
	}
	const env = process.env.FIVEX_PROMPT_TIMEOUT_MS;
	if (env === undefined || env === "") return undefined;
	return parseIntArg(env, "FIVEX_PROMPT_TIMEOUT_MS");
}

async function resolvePromptCommandContext(
	deps: PromptHandlerDeps,
): Promise<PromptCommandContext> {
	if (deps.store) {
		return {
			store: deps.store,
			runExists: deps.runExists ?? (() => false),
		};
	}
	if (!deps.resolveContext) {
		throw new Error("prompt handler requires store or resolveContext");
	}
	return deps.resolveContext();
}

function parseConfirmDefault(raw: string): boolean {
	const lower = raw.toLowerCase();
	if (lower === "yes" || lower === "y" || lower === "true") return true;
	if (lower === "no" || lower === "n" || lower === "false") return false;
	outputError(
		"INVALID_DEFAULT",
		`Default value must be "yes" or "no", got "${raw}"`,
	);
}

function emitSuccess(kind: PromptKind, prompt: PromptRecord): void {
	const answer = prompt.answer ?? "";
	if (kind === "choose") {
		outputSuccess({ choice: answer });
		return;
	}
	if (kind === "confirm") {
		outputSuccess({ confirmed: answer === "true" });
		return;
	}
	outputSuccess({ input: answer });
}

function emitAbandoned(
	prompt: PromptRecord,
	getAbortCause: () => CliAbortCause | undefined,
): never {
	switch (prompt.abandonReason) {
		case "timeout":
			outputError("PROMPT_TIMEOUT", TIMEOUT_MESSAGE);
			break;
		case "interrupted":
			if (getAbortCause() === "SIGTERM") {
				outputError("TERMINATED", TERMINATED_MESSAGE);
			}
			outputError("INTERRUPTED", INTERRUPTED_MESSAGE);
			break;
		case "eof":
			outputError("EOF", EOF_MESSAGE);
			break;
		case "non-interactive":
			outputError("NON_INTERACTIVE", NON_INTERACTIVE_MESSAGE);
			break;
		default:
			outputError(
				"PROMPT_TIMEOUT",
				prompt.abandonReason
					? `Prompt abandoned (${prompt.abandonReason})`
					: TIMEOUT_MESSAGE,
			);
	}
}

function casAnswer(
	store: PromptStore,
	id: string,
	answer: string,
	answeredBy: "terminal" | "default",
	kind: PromptKind,
	getAbortCause: () => CliAbortCause | undefined,
): void {
	const result = store.answerPrompt(id, answer, answeredBy);
	if (result.prompt.answeredAt !== null) {
		emitSuccess(kind, result.prompt);
		return;
	}
	if (result.prompt.abandonedAt !== null) {
		emitAbandoned(result.prompt, getAbortCause);
	}
	outputError("PROMPT_TIMEOUT", TIMEOUT_MESSAGE);
}

function casAbandon(
	store: PromptStore,
	id: string,
	reason: AbandonReason,
	kind: PromptKind,
	getAbortCause: () => CliAbortCause | undefined,
): void {
	const result = store.abandonPrompt(id, reason);
	if (result.prompt.answeredAt !== null) {
		emitSuccess(kind, result.prompt);
		return;
	}
	emitAbandoned(result.prompt, getAbortCause);
}

function abandonReasonForError(err: unknown): AbandonReason | undefined {
	if (!(err instanceof CliError)) return undefined;
	switch (err.code) {
		case "INTERRUPTED":
		case "TERMINATED":
			return "interrupted";
		case "EOF":
			return "eof";
		case "NON_INTERACTIVE":
			return "non-interactive";
		case "PROMPT_TIMEOUT":
			return "timeout";
		default:
			return undefined;
	}
}

async function withCreatedPrompt(
	store: PromptStore,
	input: Parameters<PromptStore["createPrompt"]>[0],
	fn: (prompt: PromptRecord) => Promise<void>,
): Promise<void> {
	const prompt = store.createPrompt(input);
	try {
		await fn(prompt);
	} catch (err) {
		const row = store.getPrompt(prompt.id);
		if (row && row.answeredAt === null && row.abandonedAt === null) {
			const reason = abandonReasonForError(err);
			if (reason) store.abandonPrompt(prompt.id, reason);
		}
		throw err;
	}
}

async function settlePoll(
	store: PromptStore,
	id: string,
	opts: {
		pollIntervalMs?: number;
		timeoutMs?: number | null;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		signal: AbortSignal;
	},
): Promise<PollRace> {
	try {
		const prompt = await waitForPromptAnswer(store, id, opts);
		return { tag: "answered", prompt };
	} catch (err) {
		if (err instanceof PromptTimeoutError) return { tag: "timeout" };
		if (err instanceof PromptAbandonedError) {
			return { tag: "abandoned", prompt: err.prompt };
		}
		if (err instanceof PromptWaitAbortedError) return { tag: "poll-aborted" };
		throw err;
	}
}

async function waitForPromptRace(args: {
	store: PromptStore;
	id: string;
	kind: PromptKind;
	defaultAnswer: string | null;
	timeoutMs: number | undefined;
	deps: PromptHandlerDeps;
	readInput?: (signal: AbortSignal) => Promise<InputRace>;
}): Promise<void> {
	const { store, id, kind, defaultAnswer, timeoutMs, deps, readInput } = args;
	const getAbortSignal = deps.getAbortSignal ?? getCliAbortSignal;
	const getAbortCause = deps.getAbortCause ?? getCliAbortCause;
	const lifecycle = getAbortSignal();

	if (lifecycle.aborted) {
		casAbandon(store, id, "interrupted", kind, getAbortCause);
		return;
	}

	const stdinCtl = new AbortController();
	const pollCtl = new AbortController();
	const onLifecycleAbort = () => {
		stdinCtl.abort();
		pollCtl.abort();
	};
	lifecycle.addEventListener("abort", onLifecycleAbort, { once: true });

	const pollPromise = settlePoll(store, id, {
		pollIntervalMs: deps.pollIntervalMs ?? PROMPT_POLL_INTERVAL_MS,
		timeoutMs: timeoutMs ?? null,
		sleep: deps.sleep,
		now: deps.now,
		signal: pollCtl.signal,
	}).then((result) => {
		stdinCtl.abort();
		return result;
	});

	let winner: RaceWinner;
	try {
		if (readInput) {
			const inputPromise = readInput(stdinCtl.signal).then((result) => {
				pollCtl.abort();
				return result;
			});
			winner = await Promise.race([
				inputPromise.then(
					(result): RaceWinner => ({ source: "input", result }),
				),
				pollPromise.then((result): RaceWinner => ({ source: "poll", result })),
			]);
		} else {
			winner = { source: "poll", result: await pollPromise };
		}
	} finally {
		lifecycle.removeEventListener("abort", onLifecycleAbort);
		stdinCtl.abort();
		pollCtl.abort();
	}

	const cause = getAbortCause();
	const current = store.getPrompt(id);

	if (current?.answeredAt) {
		emitSuccess(kind, current);
		return;
	}

	const lifecycleAbort = cause === "SIGINT" || cause === "SIGTERM";

	if (winner.source === "poll") {
		switch (winner.result.tag) {
			case "answered":
				emitSuccess(kind, winner.result.prompt);
				return;
			case "timeout":
				casAbandon(store, id, "timeout", kind, getAbortCause);
				return;
			case "abandoned":
				emitAbandoned(winner.result.prompt, getAbortCause);
				return;
			case "poll-aborted":
				if (lifecycleAbort) {
					casAbandon(store, id, "interrupted", kind, getAbortCause);
					return;
				}
				// Local cancellation after another branch won. Re-read; if still
				// open this is unexpected — treat as timeout safety net.
				if (current?.abandonedAt) {
					emitAbandoned(current, getAbortCause);
				}
				outputError("PROMPT_TIMEOUT", TIMEOUT_MESSAGE);
		}
	}

	if (winner.source !== "input") {
		outputError("PROMPT_TIMEOUT", TIMEOUT_MESSAGE);
	}
	const input = winner.result;
	switch (input.tag) {
		case "value":
			casAnswer(store, id, input.value, "terminal", kind, getAbortCause);
			return;
		case "eof":
			if (kind === "input") {
				casAnswer(store, id, "", "terminal", kind, getAbortCause);
				return;
			}
			if (defaultAnswer !== null) {
				casAnswer(store, id, defaultAnswer, "default", kind, getAbortCause);
				return;
			}
			casAbandon(store, id, "eof", kind, getAbortCause);
			return;
		case "sigint":
			casAbandon(store, id, "interrupted", kind, getAbortCause);
			return;
		case "aborted":
			if (lifecycleAbort) {
				casAbandon(store, id, "interrupted", kind, getAbortCause);
				return;
			}
			if (current?.abandonedAt) {
				emitAbandoned(current, getAbortCause);
			}
			// Store win is handled by the answeredAt check above. Timeout that
			// aborted stdin should have arrived as poll timeout; if we got here
			// the poll branch lost the race to stdin ABORTED.
			outputError("PROMPT_TIMEOUT", TIMEOUT_MESSAGE);
	}
}

function shouldWait(args: {
	tty: boolean;
	kind: PromptKind;
	hasDefault: boolean;
	timeoutMs: number | undefined;
}): boolean {
	if (args.tty) return true;
	if (args.kind === "input") return true;
	if (args.hasDefault) return false;
	return args.timeoutMs !== undefined && args.timeoutMs > 0;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function promptChoose(
	params: ChooseParams,
	deps: PromptHandlerDeps = {},
): Promise<void> {
	const optionsList = params.options
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);

	if (optionsList.length === 0) {
		outputError(
			"INVALID_OPTIONS",
			"At least one option must be provided via --options",
		);
	}

	const defaultVal = params.default;
	if (defaultVal && !optionsList.includes(defaultVal)) {
		outputError(
			"INVALID_DEFAULT",
			`Default value "${defaultVal}" is not in the options list`,
			{ options: optionsList, default: defaultVal },
		);
	}

	const timeoutMs = resolveTimeoutMs(params.timeout);
	const { store, runExists } = await resolvePromptCommandContext(deps);
	if (params.run && !runExists(params.run)) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	const tty = (deps.isTTY ?? detectTTY)();
	const readLine = deps.readLine ?? defaultReadLine;

	await withCreatedPrompt(
		store,
		{
			runId: params.run ?? null,
			kind: "choose",
			message: params.message,
			options: optionsList,
			defaultValue: defaultVal ?? null,
		},
		async (prompt) => {
			if (
				!shouldWait({
					tty,
					kind: "choose",
					hasDefault: Boolean(defaultVal),
					timeoutMs,
				})
			) {
				if (defaultVal) {
					casAnswer(
						store,
						prompt.id,
						defaultVal,
						"default",
						"choose",
						deps.getAbortCause ?? getCliAbortCause,
					);
					return;
				}
				casAbandon(
					store,
					prompt.id,
					"non-interactive",
					"choose",
					deps.getAbortCause ?? getCliAbortCause,
				);
				return;
			}

			if (tty) {
				promptLine("");
				promptLine(`  ${params.message}`);
				promptLine("");
				for (let i = 0; i < optionsList.length; i++) {
					const marker = defaultVal === optionsList[i] ? " (default)" : "";
					promptLine(`    ${i + 1}. ${optionsList[i]}${marker}`);
				}
				promptLine("");
			}

			const defaultHint = defaultVal ? ` [${defaultVal}]` : "";
			await waitForPromptRace({
				store,
				id: prompt.id,
				kind: "choose",
				defaultAnswer: defaultVal ?? null,
				timeoutMs,
				deps,
				readInput: tty
					? async (signal) => {
							for (;;) {
								promptWrite(`  Choice${defaultHint}: `);
								const input = await readLine(signal);
								if (input === ABORTED) return { tag: "aborted" };
								if (input === EOF) return { tag: "eof" };
								if (input === SIGINT) return { tag: "sigint" };
								if (typeof input !== "string") continue;
								const trimmed = input.trim();
								if (!trimmed) {
									if (defaultVal) {
										return { tag: "value", value: defaultVal };
									}
									promptLine(
										"  Invalid selection. Please enter a number or option name.",
									);
									continue;
								}
								const num = Number.parseInt(trimmed, 10);
								const selected = optionsList[num - 1];
								if (selected !== undefined) {
									return { tag: "value", value: selected };
								}
								const match = optionsList.find(
									(o) => o.toLowerCase() === trimmed.toLowerCase(),
								);
								if (match) return { tag: "value", value: match };
								promptLine(
									"  Invalid selection. Please enter a number or option name.",
								);
							}
						}
					: undefined,
			});
		},
	);
}

export async function promptConfirm(
	params: ConfirmParams,
	deps: PromptHandlerDeps = {},
): Promise<void> {
	const defaultVal = params.default;
	let defaultBool: boolean | undefined;
	if (defaultVal !== undefined) {
		defaultBool = parseConfirmDefault(defaultVal);
	}
	const defaultAnswer =
		defaultBool === undefined ? null : defaultBool ? "true" : "false";

	const timeoutMs = resolveTimeoutMs(params.timeout);
	const { store, runExists } = await resolvePromptCommandContext(deps);
	if (params.run && !runExists(params.run)) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	const tty = (deps.isTTY ?? detectTTY)();
	const readLine = deps.readLine ?? defaultReadLine;

	await withCreatedPrompt(
		store,
		{
			runId: params.run ?? null,
			kind: "confirm",
			message: params.message,
			options: null,
			defaultValue: defaultVal ?? null,
		},
		async (prompt) => {
			if (
				!shouldWait({
					tty,
					kind: "confirm",
					hasDefault: defaultBool !== undefined,
					timeoutMs,
				})
			) {
				if (defaultAnswer !== null) {
					casAnswer(
						store,
						prompt.id,
						defaultAnswer,
						"default",
						"confirm",
						deps.getAbortCause ?? getCliAbortCause,
					);
					return;
				}
				casAbandon(
					store,
					prompt.id,
					"non-interactive",
					"confirm",
					deps.getAbortCause ?? getCliAbortCause,
				);
				return;
			}

			const hint =
				defaultBool === true
					? "[Y/n]"
					: defaultBool === false
						? "[y/N]"
						: "[y/n]";

			await waitForPromptRace({
				store,
				id: prompt.id,
				kind: "confirm",
				defaultAnswer,
				timeoutMs,
				deps,
				readInput: tty
					? async (signal) => {
							for (;;) {
								promptWrite(`  ${params.message} ${hint}: `);
								const input = await readLine(signal);
								if (input === ABORTED) return { tag: "aborted" };
								if (input === EOF) return { tag: "eof" };
								if (input === SIGINT) return { tag: "sigint" };
								if (typeof input !== "string") continue;
								const trimmed = input.trim().toLowerCase();
								if (!trimmed && defaultAnswer !== null) {
									return { tag: "value", value: defaultAnswer };
								}
								if (
									trimmed === "y" ||
									trimmed === "yes" ||
									trimmed === "true"
								) {
									return { tag: "value", value: "true" };
								}
								if (
									trimmed === "n" ||
									trimmed === "no" ||
									trimmed === "false"
								) {
									return { tag: "value", value: "false" };
								}
								promptLine("  Invalid input. Please enter y or n.");
							}
						}
					: undefined,
			});
		},
	);
}

export async function promptInput(
	params: InputParams,
	deps: PromptHandlerDeps = {},
): Promise<void> {
	const timeoutMs = resolveTimeoutMs(params.timeout);
	const { store, runExists } = await resolvePromptCommandContext(deps);
	if (params.run && !runExists(params.run)) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	const tty = (deps.isTTY ?? detectTTY)();
	const readLine = deps.readLine ?? defaultReadLine;
	const readAll = deps.readAll ?? defaultReadAll;
	const readStdinPipe = deps.readStdinPipe ?? defaultReadStdinPipe;

	await withCreatedPrompt(
		store,
		{
			runId: params.run ?? null,
			kind: "input",
			message: params.message,
			options: null,
			defaultValue: null,
		},
		async (prompt) => {
			await waitForPromptRace({
				store,
				id: prompt.id,
				kind: "input",
				defaultAnswer: null,
				timeoutMs,
				deps,
				readInput: async (signal) => {
					if (!tty) {
						const text = await readStdinPipe(signal);
						if (text === ABORTED) return { tag: "aborted" };
						return { tag: "value", value: text };
					}
					if (params.multiline) {
						promptLine(`  ${params.message} (Ctrl+D to finish):`);
						const text = await readAll(signal);
						if (text === ABORTED) return { tag: "aborted" };
						if (text === SIGINT) return { tag: "sigint" };
						return { tag: "value", value: text };
					}
					promptWrite(`  ${params.message}: `);
					const text = await readLine(signal);
					if (text === ABORTED) return { tag: "aborted" };
					if (text === EOF) return { tag: "eof" };
					if (text === SIGINT) return { tag: "sigint" };
					return { tag: "value", value: text };
				},
			});
		},
	);
}
