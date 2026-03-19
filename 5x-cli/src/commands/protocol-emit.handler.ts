/**
 * Protocol emit handler — business logic for `5x protocol emit`.
 *
 * Produces canonical JSON structured output for agents. The agent includes
 * this output verbatim as its structured result.
 *
 * Success: writes raw canonical JSON to stdout (NOT wrapped in outputSuccess
 * envelope). Error: uses outputError() (standard { ok: false, error } envelope).
 *
 * Phase 3, 022-orchestration-reliability.
 */

import { outputError } from "../output.js";
import {
	type AuthorStatus,
	assertAuthorStatus,
	assertReviewerVerdict,
	type ReviewerVerdict,
	type VerdictItem,
} from "../protocol.js";
import {
	normalizeAuthorStatus,
	normalizeReviewerVerdict,
} from "../protocol-normalize.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProtocolEmitReviewerParams {
	ready?: boolean;
	item?: string[];
	summary?: string;
	stdinData?: string;
}

export interface ProtocolEmitAuthorParams {
	complete?: boolean;
	needsHuman?: boolean;
	failed?: boolean;
	commit?: string;
	reason?: string;
	notes?: string;
	stdinData?: string;
}

// ---------------------------------------------------------------------------
// Stdin helper
// ---------------------------------------------------------------------------

async function readStdinIfPiped(): Promise<string | undefined> {
	// Check if stdin is piped (not a TTY)
	if (process.stdin.isTTY) return undefined;

	const chunks: Buffer[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf-8").trim();
	return text || undefined;
}

// ---------------------------------------------------------------------------
// Reviewer emit
// ---------------------------------------------------------------------------

export async function protocolEmitReviewer(
	params: ProtocolEmitReviewerParams,
): Promise<void> {
	const { ready, item: itemJsonStrings, summary, stdinData } = params;

	// Stdin fallback: if no readiness flags provided and stdin has data
	if (ready === undefined) {
		const stdin = stdinData ?? (await readStdinIfPiped());
		if (stdin) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdin);
			} catch {
				outputError(
					"INVALID_JSON",
					"Stdin is not valid JSON. Provide --ready or --no-ready flags, or pipe valid JSON.",
				);
			}

			const normalized = normalizeReviewerVerdict(parsed);
			const verdict = normalized as ReviewerVerdict;

			const result = assertReviewerVerdict(verdict, "protocol emit reviewer");
			for (const w of result.warnings) {
				console.error(`Warning: ${w}`);
			}

			process.stdout.write(JSON.stringify(verdict));
			return;
		}

		outputError(
			"INVALID_ARGS",
			"Missing --ready or --no-ready flag. Use --ready or --no-ready to set the readiness assessment, or pipe JSON to stdin.",
		);
	}

	// Parse item JSON strings
	const items: VerdictItem[] = [];
	if (itemJsonStrings) {
		for (let i = 0; i < itemJsonStrings.length; i++) {
			const raw = itemJsonStrings[i] as string;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				outputError(
					"INVALID_JSON",
					`--item at index ${i} is not valid JSON: ${raw.slice(0, 100)}`,
				);
			}

			const rec = parsed as Record<string, unknown>;
			const item: VerdictItem = {
				id: (rec.id as string) || `R${i + 1}`,
				title: (rec.title as string) || "",
				action: (rec.action as VerdictItem["action"]) || "human_required",
				reason: (rec.reason as string) || "",
				...(rec.priority
					? { priority: rec.priority as VerdictItem["priority"] }
					: {}),
			};
			items.push(item);
		}
	}

	// Derive readiness from flags + item presence
	let readiness: ReviewerVerdict["readiness"];
	if (ready) {
		readiness = items.length > 0 ? "ready_with_corrections" : "ready";
	} else {
		readiness = "not_ready";
	}

	const verdict: ReviewerVerdict = {
		readiness,
		items,
		...(summary ? { summary } : {}),
	};

	// Run through normalization (handles defaults, id generation for items)
	const normalized = normalizeReviewerVerdict(verdict) as ReviewerVerdict;

	// Validate
	const assertResult = assertReviewerVerdict(
		normalized,
		"protocol emit reviewer",
	);
	for (const w of assertResult.warnings) {
		console.error(`Warning: ${w}`);
	}

	// Write raw canonical JSON to stdout
	process.stdout.write(JSON.stringify(normalized));
}

// ---------------------------------------------------------------------------
// Author emit
// ---------------------------------------------------------------------------

export async function protocolEmitAuthor(
	params: ProtocolEmitAuthorParams,
): Promise<void> {
	const { complete, needsHuman, failed, commit, reason, notes, stdinData } =
		params;

	// Count result flags
	const flagCount = [complete, needsHuman, failed].filter(Boolean).length;

	// Stdin fallback: if no result flags and stdin has data
	if (flagCount === 0) {
		const stdin = stdinData ?? (await readStdinIfPiped());
		if (stdin) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdin);
			} catch {
				outputError(
					"INVALID_JSON",
					"Stdin is not valid JSON. Provide --complete, --needs-human, or --failed flags, or pipe valid JSON.",
				);
			}

			const normalized = normalizeAuthorStatus(parsed) as AuthorStatus;
			assertAuthorStatus(normalized, "protocol emit author", {
				requireCommit: false,
			});

			process.stdout.write(JSON.stringify(normalized));
			return;
		}

		outputError(
			"INVALID_ARGS",
			"Missing result flag. Provide exactly one of --complete, --needs-human, or --failed, or pipe JSON to stdin.",
		);
	}

	// Exactly one result flag required
	if (flagCount > 1) {
		outputError(
			"INVALID_ARGS",
			"Provide exactly one of --complete, --needs-human, or --failed.",
		);
	}

	// Determine result
	let result: AuthorStatus["result"];
	if (complete) result = "complete";
	else if (needsHuman) result = "needs_human";
	else result = "failed";

	// Validate conditional requirements
	if (result !== "complete" && !reason) {
		outputError(
			"INVALID_ARGS",
			`--reason is required with --${result === "needs_human" ? "needs-human" : "failed"}. Explain why.`,
		);
	}

	const status: AuthorStatus = {
		result,
		...(commit ? { commit } : {}),
		...(reason ? { reason } : {}),
		...(notes ? { notes } : {}),
	};

	// Run through normalization
	const normalized = normalizeAuthorStatus(status) as AuthorStatus;

	// Validate
	assertAuthorStatus(normalized, "protocol emit author", {
		requireCommit: false,
	});

	// Write raw canonical JSON to stdout
	process.stdout.write(JSON.stringify(normalized));
}
