/**
 * Shared pipe utility for reading upstream 5x JSON envelopes from stdin.
 *
 * Used by `run record` and `invoke` to auto-extract context from piped output
 * of upstream commands (e.g., `5x invoke author ... | 5x run record`).
 *
 * IMPORTANT: isStdinPiped() uses process.stdin.isTTY directly — it must NOT
 * reuse anything from src/utils/stdin.ts, which has /dev/tty fallback logic
 * designed for interactive prompts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of context extracted from an upstream 5x envelope. */
export interface PipeContext {
	/** Run ID from upstream command. */
	runId?: string;
	/** Step name from upstream command (e.g., from template frontmatter). */
	stepName?: string;
	/** Phase identifier. */
	phase?: string;
	/** Mapped worktree path (Phase 2: from invoke envelope). */
	worktreePath?: string;
	/** Effective plan path in worktree (Phase 2: from invoke envelope). */
	worktreePlanPath?: string;
	/** Template variable fallbacks — eligible string fields from upstream data. */
	templateVars: Record<string, string>;
}

/** Invoke-specific metadata extracted from an upstream invoke envelope. */
export interface InvokeMetadata {
	result: unknown;
	sessionId?: string;
	model?: string;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	logPath?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Internal metadata keys excluded from template variable injection.
 * These fields are either internal plumbing or would create confusing
 * implicit template bindings.
 */
const EXCLUDED_TEMPLATE_VAR_KEYS = new Set([
	"run_id",
	"session_id",
	"log_path",
	"cost_usd",
	"duration_ms",
	"model",
	"step_name",
	"ok",
	// Phase 2: worktree context fields are internal plumbing, not template vars
	"worktree_path",
	"worktree_plan_path",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether stdin is piped (not a TTY).
 * Uses process.stdin.isTTY directly — NOT the prompt helpers in utils/stdin.ts.
 */
export function isStdinPiped(): boolean {
	return !process.stdin.isTTY;
}

/**
 * Read and parse an upstream 5x JSON envelope from stdin.
 *
 * Returns null if stdin is not piped (isTTY is true).
 * Throws if stdin is piped but content is not valid JSON or not a
 * successful envelope ({ ok: true }).
 */
export async function readUpstreamEnvelope(): Promise<{
	data: Record<string, unknown>;
	raw: string;
} | null> {
	if (!isStdinPiped()) {
		return null;
	}

	// In a legitimate pipe (cmd1 | cmd2), upstream data arrives immediately.
	// In agent/IDE harness contexts, stdin is piped but empty with no EOF —
	// a blocking read would hang forever. Use a timeout on the first chunk
	// to distinguish the two cases.
	const reader = Bun.stdin.stream().getReader();
	const first = await Promise.race([
		reader.read(),
		Bun.sleep(200).then(
			() =>
				({
					done: true,
					value: undefined,
				}) as ReadableStreamReadResult<Uint8Array>,
		),
	]);

	if (first.done || !first.value) {
		reader.releaseLock();
		return null;
	}

	const chunks: Uint8Array[] = [first.value];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	reader.releaseLock();

	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw.trim()) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Failed to parse upstream envelope: invalid JSON on stdin`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Upstream envelope is not a JSON object`);
	}

	const envelope = parsed as Record<string, unknown>;

	if (envelope.ok === false) {
		const error = envelope.error as Record<string, unknown> | undefined;
		const code = error?.code ?? "UNKNOWN";
		const message = error?.message ?? "Unknown error";
		throw new Error(`Upstream command failed [${code}]: ${message}`);
	}

	if (envelope.ok !== true) {
		throw new Error(
			`Upstream envelope missing "ok" field — not a valid 5x envelope`,
		);
	}

	const data = envelope.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(
			`Upstream envelope "data" field is missing or not an object`,
		);
	}

	return {
		data: data as Record<string, unknown>,
		raw,
	};
}

/**
 * Extract pipe context (run_id, step_name, phase, template var fallbacks)
 * from an upstream envelope's data payload.
 */
export function extractPipeContext(data: Record<string, unknown>): PipeContext {
	const ctx: PipeContext = { templateVars: {} };

	// Extract known context fields
	if (typeof data.run_id === "string") {
		ctx.runId = data.run_id;
	}
	if (typeof data.step_name === "string") {
		ctx.stepName = data.step_name;
	}
	if (typeof data.phase === "string") {
		ctx.phase = data.phase;
	}
	// Phase 2: extract worktree context fields
	if (typeof data.worktree_path === "string") {
		ctx.worktreePath = data.worktree_path;
	}
	if (typeof data.worktree_plan_path === "string") {
		ctx.worktreePlanPath = data.worktree_plan_path;
	}

	// Build templateVars from eligible string fields
	for (const [key, value] of Object.entries(data)) {
		// Only string values
		if (typeof value !== "string") continue;

		// Skip excluded metadata keys
		if (EXCLUDED_TEMPLATE_VAR_KEYS.has(key)) continue;

		// Template safety: skip values containing newlines or -->
		if (value.includes("\n") || value.includes("-->")) continue;

		ctx.templateVars[key] = value;
	}

	return ctx;
}

/**
 * Detect whether upstream data looks like an invoke result and extract
 * metadata fields if so. Returns null if the shape doesn't match.
 *
 * Detection heuristic: data has `result` (object) AND `session_id` (string).
 */
export function extractInvokeMetadata(
	data: Record<string, unknown>,
): InvokeMetadata | null {
	// Must have result as an object and session_id as a string
	if (
		!data.result ||
		typeof data.result !== "object" ||
		Array.isArray(data.result) ||
		typeof data.session_id !== "string"
	) {
		return null;
	}

	const meta: InvokeMetadata = {
		result: data.result,
	};

	if (typeof data.session_id === "string") {
		meta.sessionId = data.session_id;
	}
	if (typeof data.model === "string") {
		meta.model = data.model;
	}
	if (typeof data.duration_ms === "number") {
		meta.durationMs = data.duration_ms;
	}
	if (typeof data.cost_usd === "number") {
		meta.costUsd = data.cost_usd;
	}
	if (typeof data.log_path === "string") {
		meta.logPath = data.log_path;
	}

	// Extract tokens from nested { in, out } structure
	const tokens = data.tokens;
	if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
		const t = tokens as Record<string, unknown>;
		if (typeof t.in === "number") {
			meta.tokensIn = t.in;
		}
		if (typeof t.out === "number") {
			meta.tokensOut = t.out;
		}
	}

	return meta;
}
