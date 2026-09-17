/**
 * SQLite PromptStore. SQL and row mapping live only in this file.
 */

import type { Database } from "bun:sqlite";
import { createPromptId } from "./ids.js";
import type { PromptStore } from "./store.js";
import type {
	AbandonReason,
	AnsweredBy,
	CasResult,
	CreatePromptInput,
	PromptKind,
	PromptRecord,
} from "./types.js";
import { PromptStoreError } from "./types.js";

interface PromptSqlRow {
	id: string;
	run_id: string | null;
	kind: PromptKind;
	message: string;
	options_json: string | null;
	default_value: string | null;
	created_at: string;
	answered_at: string | null;
	answer: string | null;
	answered_by: AnsweredBy | null;
	abandoned_at: string | null;
	abandon_reason: AbandonReason | null;
}

function parseOptions(json: string | null): string[] | null {
	if (json === null) return null;
	return JSON.parse(json) as string[];
}

function mapRow(row: PromptSqlRow): PromptRecord {
	return {
		id: row.id,
		runId: row.run_id,
		kind: row.kind,
		message: row.message,
		options: parseOptions(row.options_json),
		defaultValue: row.default_value,
		createdAt: row.created_at,
		answeredAt: row.answered_at,
		answer: row.answer,
		answeredBy: row.answered_by,
		abandonedAt: row.abandoned_at,
		abandonReason: row.abandon_reason,
	};
}

class SqlitePromptStore implements PromptStore {
	constructor(private readonly db: Database) {}

	createPrompt(input: CreatePromptInput): PromptRecord {
		const id = input.id ?? createPromptId();
		const runId = input.runId ?? null;
		const options = input.options ?? null;
		const optionsJson = options === null ? null : JSON.stringify(options);
		const defaultValue = input.defaultValue ?? null;

		this.db
			.query(
				`INSERT INTO prompts (id, run_id, kind, message, options_json, default_value)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
			.run(id, runId, input.kind, input.message, optionsJson, defaultValue);

		return this.requirePrompt(id);
	}

	getPrompt(id: string): PromptRecord | null {
		const row = this.db
			.query("SELECT * FROM prompts WHERE id = ?1")
			.get(id) as PromptSqlRow | null;
		return row ? mapRow(row) : null;
	}

	listOpenPrompts(runId?: string): PromptRecord[] {
		const rows =
			runId === undefined
				? (this.db
						.query(
							`SELECT * FROM prompts
							 WHERE answered_at IS NULL AND abandoned_at IS NULL
							 ORDER BY created_at ASC`,
						)
						.all() as PromptSqlRow[])
				: (this.db
						.query(
							`SELECT * FROM prompts
							 WHERE answered_at IS NULL AND abandoned_at IS NULL AND run_id = ?1
							 ORDER BY created_at ASC`,
						)
						.all(runId) as PromptSqlRow[]);
		return rows.map(mapRow);
	}

	listAnsweredPrompts(runId: string): PromptRecord[] {
		const rows = this.db
			.query(
				`SELECT * FROM prompts
				 WHERE run_id = ?1 AND answered_at IS NOT NULL AND abandoned_at IS NULL
				 ORDER BY created_at ASC`,
			)
			.all(runId) as PromptSqlRow[];
		return rows.map(mapRow);
	}

	answerPrompt(id: string, answer: string, answeredBy: AnsweredBy): CasResult {
		this.db
			.query(
				`UPDATE prompts
				 SET answered_at = datetime('now'), answer = ?1, answered_by = ?2
				 WHERE id = ?3 AND answered_at IS NULL AND abandoned_at IS NULL`,
			)
			.run(answer, answeredBy, id);
		return this.casResult(id);
	}

	abandonPrompt(id: string, reason: AbandonReason): CasResult {
		this.db
			.query(
				`UPDATE prompts
				 SET abandoned_at = datetime('now'), abandon_reason = ?1
				 WHERE id = ?2 AND answered_at IS NULL AND abandoned_at IS NULL`,
			)
			.run(reason, id);
		return this.casResult(id);
	}

	private casResult(id: string): CasResult {
		const changes = this.db.query("SELECT changes() AS n").get() as {
			n: number;
		} | null;
		if ((changes?.n ?? 0) > 0) {
			return { ok: true, prompt: this.requirePrompt(id) };
		}
		const prompt = this.getPrompt(id);
		if (!prompt) {
			throw new PromptStoreError("PROMPT_NOT_FOUND", `prompt ${id} not found`);
		}
		return { ok: false, prompt };
	}

	private requirePrompt(id: string): PromptRecord {
		const prompt = this.getPrompt(id);
		if (!prompt) {
			throw new PromptStoreError("PROMPT_NOT_FOUND", `prompt ${id} not found`);
		}
		return prompt;
	}
}

export function createSqlitePromptStore(db: Database): PromptStore {
	return new SqlitePromptStore(db);
}
