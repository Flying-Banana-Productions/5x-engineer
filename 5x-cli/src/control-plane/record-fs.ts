/**
 * Working-tree JSONL RecordStore.
 *
 * Mixed-stream `atomicAppend` is a per-run transaction (multi-run batches
 * throw `INVALID_ATOMIC_APPEND`). It uses a per-run exclusive writer lock, an
 * immutable prepared journal, a separately durable checksummed commit marker,
 * and `fsyncDir` after every create/rename/unlink. Recovery is fail-closed on
 * corrupt txn metadata (`RECORD_TXN_CORRUPT`).
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { planSlugFromPath } from "../paths.js";
import {
	decodeJsonlFile,
	encodeJsonlFile,
	encodeRunJson,
	isRecordStream,
	parseRunJson,
	RECORD_STREAMS,
	runDirForSummary,
	STREAM_FILES,
} from "./record-layout.js";
import type { RecordStore } from "./record-store.js";
import {
	type AppendOp,
	type AppendResult,
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	RecordStoreError,
	type RecordStream,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	requireSingleRunAtomicAppend,
} from "./record-types.js";

export type TxnEvent =
	| "after-lock-temp-written"
	| "after-lock-linked"
	| "after-lock-acquired"
	| "after-lock-released"
	| "after-new"
	| "after-dirsync:staging"
	| "after-prepared"
	| "after-dirsync:prepared"
	| "after-commit-marker"
	| "after-dirsync:commit"
	| `after-rename:${RecordStream}`
	| `after-dirsync:rename:${RecordStream}`
	| "after-dirsync:cleanup"
	| "during-recovery";

export interface WorkingTreeRecordStoreOptions {
	recordsRoot: string;
	now?: () => string;
	/** Test-only; not re-exported from the public barrel. Default: real file/dir fsync. */
	fsyncFile?: (path: string) => void;
	fsyncDir?: (dir: string) => void;
	/** Test-only; not re-exported from the public barrel. Throw to simulate a crash. */
	onTxnEvent?: (event: TxnEvent) => void;
	/** Max wait for `.txn.lock` when another live process holds it. Default: 5000. */
	lockTimeoutMs?: number;
	/** Poll interval while waiting for `.txn.lock`. Default: 25. */
	lockPollMs?: number;
	/** Unreadable `run.json` during `listRuns`. Default: `console.warn`. */
	onWarn?: (message: string) => void;
}

interface StreamState {
	lines: Map<string, RecordLine>;
	order: string[];
}

interface PreparedStream {
	stream: RecordStream;
	created: boolean;
	newBytes: Buffer;
	oldBytes: Buffer | null;
	newSha256: string;
	oldSha256: string | null;
}

interface JournalDoc {
	version: 1;
	streams: RecordStream[];
	created: Record<string, boolean>;
	new_sha256: Record<string, string>;
	old_sha256: Record<string, string>;
}

interface CommitDoc {
	version: 1;
	journal_sha256: string;
}

interface LockDoc {
	version: 1;
	pid: number;
	owner: string;
	started_at: string;
}

interface LockOwner {
	pid: number;
	owner: string;
	depth: number;
}

const LOCK_OWNERS = new Map<string, LockOwner>();

const LOCK_NAME = ".txn.lock";
const JOURNAL_NAME = ".txn.journal.json";
const COMMIT_NAME = ".txn.commit";

function utcNow(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function isErrno(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === code
	);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (isErrno(err, "EPERM")) return true;
		return false;
	}
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function defaultFsyncFile(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function defaultFsyncDir(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch (err) {
		if (!isErrno(err, "ENOENT")) throw err;
	}
}

function readFileBuffer(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (err) {
		if (isErrno(err, "ENOENT")) return null;
		throw err;
	}
}

function durableWriteFile(
	path: string,
	bytes: Buffer | string,
	fsyncFile: (p: string) => void,
	fsyncDir: (d: string) => void,
): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, bytes);
	fsyncFile(tmp);
	renameSync(tmp, path);
	fsyncDir(dirname(path));
}

function mkdirDurable(dir: string, fsyncDir: (d: string) => void): void {
	if (existsSync(dir)) return;
	const parent = dirname(dir);
	if (parent !== dir) mkdirDurable(parent, fsyncDir);
	mkdirSync(dir);
	fsyncDir(parent);
}

function emptyStream(): StreamState {
	return { lines: new Map(), order: [] };
}

function streamFromLines(lines: RecordLine[]): StreamState {
	const state = emptyStream();
	for (const line of lines) {
		if (state.lines.has(line.idempotencyKey)) continue;
		state.lines.set(line.idempotencyKey, structuredClone(line));
		state.order.push(line.idempotencyKey);
	}
	return state;
}

function cloneLine(line: RecordLine): RecordLine {
	return structuredClone(line);
}

function validateEnvelope(op: AppendOp): void {
	if (op.provenance === "recorded") {
		if (op.origin === null) {
			throw new RecordStoreError(
				"INVALID_ORIGIN",
				"recorded lines require a non-null origin",
			);
		}
		if (op.materializer !== undefined) {
			throw new RecordStoreError(
				"INVALID_ORIGIN",
				"recorded lines must not include materializer",
			);
		}
	}
}

function requireStream(stream: string): RecordStream {
	if (!isRecordStream(stream)) {
		throw new RecordStoreError(
			"INVALID_STREAM",
			`invalid record stream: ${stream}`,
		);
	}
	return stream;
}

function applyOp(state: StreamState, op: AppendOp, now: string): AppendResult {
	const stream = requireStream(op.stream);
	validateEnvelope(op);
	const existing = state.lines.get(op.idempotencyKey);
	if (existing) {
		return { created: false, line: cloneLine(existing) };
	}
	const line: RecordLine = {
		runId: op.runId,
		stream,
		idempotencyKey: op.idempotencyKey,
		payload: structuredClone(op.payload),
		createdAt: op.createdAt ?? now,
		schemaVersion: op.schemaVersion ?? RECORD_LINE_SCHEMA_VERSION,
		provenance: op.provenance,
		origin: structuredClone(op.origin),
	};
	if (op.materializer !== undefined) {
		line.materializer = structuredClone(op.materializer);
	}
	state.lines.set(op.idempotencyKey, line);
	state.order.push(op.idempotencyKey);
	return { created: true, line: cloneLine(line) };
}

function orderedLines(state: StreamState): RecordLine[] {
	const lines: RecordLine[] = [];
	for (const key of state.order) {
		const line = state.lines.get(key);
		if (line) lines.push(cloneLine(line));
	}
	return lines;
}

function lockPath(runDir: string): string {
	return join(runDir, LOCK_NAME);
}

function journalPath(runDir: string): string {
	return join(runDir, JOURNAL_NAME);
}

function commitPath(runDir: string): string {
	return join(runDir, COMMIT_NAME);
}

function stagingPath(
	runDir: string,
	stream: RecordStream,
	kind: "new" | "old",
): string {
	return join(runDir, `.txn.${stream}.${kind}`);
}

function streamPath(runDir: string, stream: RecordStream): string {
	return join(runDir, STREAM_FILES[stream]);
}

function parseLockDoc(text: string): LockDoc | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		const obj = parsed as Record<string, unknown>;
		if (obj.version !== 1) return null;
		if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid)) return null;
		if (typeof obj.owner !== "string" || obj.owner.length === 0) return null;
		if (typeof obj.started_at !== "string") return null;
		return {
			version: 1,
			pid: obj.pid,
			owner: obj.owner,
			started_at: obj.started_at,
		};
	} catch {
		return null;
	}
}

function parseJournalDoc(text: string): JournalDoc | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		const obj = parsed as Record<string, unknown>;
		if (obj.version !== 1) return null;
		if (!Array.isArray(obj.streams)) return null;
		const streams: RecordStream[] = [];
		for (const s of obj.streams) {
			if (typeof s !== "string" || !isRecordStream(s)) return null;
			streams.push(s);
		}
		if (!isPlainRecord(obj.created) || !isPlainRecord(obj.new_sha256)) {
			return null;
		}
		const created: Record<string, boolean> = {};
		const newSha: Record<string, string> = {};
		const oldSha: Record<string, string> = {};
		for (const stream of streams) {
			if (typeof obj.created[stream] !== "boolean") return null;
			if (typeof obj.new_sha256[stream] !== "string") return null;
			created[stream] = obj.created[stream] as boolean;
			newSha[stream] = obj.new_sha256[stream] as string;
		}
		if (obj.old_sha256 !== undefined) {
			if (!isPlainRecord(obj.old_sha256)) return null;
			for (const [key, value] of Object.entries(obj.old_sha256)) {
				if (typeof value !== "string") return null;
				oldSha[key] = value;
			}
		}
		return {
			version: 1,
			streams,
			created,
			new_sha256: newSha,
			old_sha256: oldSha,
		};
	} catch {
		return null;
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommitDoc(text: string): CommitDoc | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isPlainRecord(parsed)) return null;
		if (parsed.version !== 1) return null;
		if (typeof parsed.journal_sha256 !== "string") return null;
		return { version: 1, journal_sha256: parsed.journal_sha256 };
	} catch {
		return null;
	}
}

/** Test-only: drop process-local lock owners (simulates process death). */
export function resetWorkingTreeLockOwnersForTest(): void {
	LOCK_OWNERS.clear();
}

export type TxnLockState = "absent" | "live" | "stale" | "malformed";

/**
 * Classify `.txn.lock` without stealing or waiting.
 *
 * Doctor uses this to skip in-flight (live PID) and malformed locks
 * (P0.5: do not treat empty/unreadable as absent, do not steal this pass).
 */
export function inspectTxnLock(runDir: string): TxnLockState {
	const dest = lockPath(runDir);
	if (!existsSync(dest)) return "absent";
	let text: string;
	try {
		text = readFileSync(dest, "utf8");
	} catch {
		return "malformed";
	}
	if (text.trim() === "") return "malformed";
	const parsed = parseLockDoc(text);
	if (!parsed) return "malformed";
	return isPidAlive(parsed.pid) ? "live" : "stale";
}

function journalChecksumsMatch(runDir: string, journal: JournalDoc): boolean {
	for (const stream of journal.streams) {
		const newBytes = readFileBuffer(stagingPath(runDir, stream, "new"));
		if (newBytes && sha256(newBytes) !== journal.new_sha256[stream]) {
			return false;
		}
		const oldBytes = readFileBuffer(stagingPath(runDir, stream, "old"));
		const expectedOld = journal.old_sha256[stream];
		if (oldBytes && (!expectedOld || sha256(oldBytes) !== expectedOld)) {
			return false;
		}
	}
	return true;
}

function noUnexpectedStaging(runDir: string, journal: JournalDoc): boolean {
	const listed = new Set(journal.streams);
	for (const stream of RECORD_STREAMS) {
		const hasNew = existsSync(stagingPath(runDir, stream, "new"));
		const hasOld = existsSync(stagingPath(runDir, stream, "old"));
		if ((hasNew || hasOld) && !listed.has(stream)) return false;
	}
	return true;
}

function liveMatchesNewSha(
	runDir: string,
	journal: JournalDoc,
	stream: RecordStream,
): boolean {
	const live = readFileBuffer(streamPath(runDir, stream));
	const expected = journal.new_sha256[stream];
	return Boolean(live && expected && sha256(live) === expected);
}

function rollbackProofHolds(runDir: string, journal: JournalDoc): boolean {
	for (const stream of journal.streams) {
		const newBytes = readFileBuffer(stagingPath(runDir, stream, "new"));
		if (!newBytes || sha256(newBytes) !== journal.new_sha256[stream]) {
			return false;
		}
		const created = journal.created[stream] === true;
		const oldBytes = readFileBuffer(stagingPath(runDir, stream, "old"));
		const live = readFileBuffer(streamPath(runDir, stream));
		if (created) {
			if (oldBytes !== null) return false;
			if (live !== null) return false;
		} else {
			const expectedOld = journal.old_sha256[stream];
			if (!oldBytes || !expectedOld || sha256(oldBytes) !== expectedOld) {
				return false;
			}
			if (!live || sha256(live) !== expectedOld) return false;
		}
	}
	return true;
}

function fullyAppliedWithoutCommit(
	runDir: string,
	journal: JournalDoc,
): boolean {
	for (const stream of journal.streams) {
		if (existsSync(stagingPath(runDir, stream, "new"))) return false;
		if (!liveMatchesNewSha(runDir, journal, stream)) return false;
	}
	return true;
}

function forwardWouldFail(runDir: string, journal: JournalDoc): boolean {
	for (const stream of journal.streams) {
		if (existsSync(stagingPath(runDir, stream, "new"))) {
			const bytes = readFileBuffer(stagingPath(runDir, stream, "new"));
			if (!bytes || sha256(bytes) !== journal.new_sha256[stream]) {
				return true;
			}
			continue;
		}
		if (!liveMatchesNewSha(runDir, journal, stream)) return true;
	}
	return false;
}

/**
 * True when leftover `.txn.journal.json` / `.txn.commit` would fail
 * `recoverRunDir` with `RECORD_TXN_CORRUPT`. Does not mutate the run dir.
 */
export function isRunTxnCorrupt(runDir: string): boolean {
	const journalBytes = readFileBuffer(journalPath(runDir));
	const commitBytes = readFileBuffer(commitPath(runDir));
	const commitExists = commitBytes !== null || existsSync(commitPath(runDir));

	if (!journalBytes && !commitExists) return false;

	const journal =
		journalBytes !== null
			? parseJournalDoc(journalBytes.toString("utf8"))
			: null;
	const journalOk =
		journal !== null &&
		journalChecksumsMatch(runDir, journal) &&
		noUnexpectedStaging(runDir, journal);
	const commit =
		commitBytes !== null ? parseCommitDoc(commitBytes.toString("utf8")) : null;
	const journalSha = journalBytes ? sha256(journalBytes) : null;
	const commitOk =
		commit !== null &&
		journalSha !== null &&
		commit.journal_sha256 === journalSha;

	if (!journalOk || (commitExists && !commitOk)) return true;

	if (journalOk && commitOk && journal) {
		return forwardWouldFail(runDir, journal);
	}

	if (journalOk && !commitExists && journal) {
		if (rollbackProofHolds(runDir, journal)) return false;
		if (fullyAppliedWithoutCommit(runDir, journal)) return false;
		return true;
	}

	return false;
}

/** True when a journal or commit marker is present (recoverable or corrupt). */
export function runDirHasTxnArtifacts(runDir: string): boolean {
	return (
		existsSync(journalPath(runDir)) ||
		existsSync(commitPath(runDir)) ||
		RECORD_STREAMS.some(
			(stream) =>
				existsSync(stagingPath(runDir, stream, "new")) ||
				existsSync(stagingPath(runDir, stream, "old")),
		)
	);
}

class WorkingTreeRecordStore implements RecordStore {
	private readonly recordsRoot: string;
	private readonly now: () => string;
	private readonly fsyncFileFn: (path: string) => void;
	private readonly fsyncDirFn: (dir: string) => void;
	private readonly onTxnEvent?: (event: TxnEvent) => void;
	private readonly lockTimeoutMs: number;
	private readonly lockPollMs: number;
	private readonly onWarn: (message: string) => void;

	constructor(opts: WorkingTreeRecordStoreOptions) {
		this.recordsRoot = resolve(opts.recordsRoot);
		this.now = opts.now ?? utcNow;
		this.fsyncFileFn = opts.fsyncFile ?? defaultFsyncFile;
		this.fsyncDirFn = opts.fsyncDir ?? defaultFsyncDir;
		this.onTxnEvent = opts.onTxnEvent;
		this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
		this.lockPollMs = opts.lockPollMs ?? 25;
		this.onWarn = opts.onWarn ?? ((message) => console.warn(message));
	}

	private fire(event: TxnEvent): void {
		this.onTxnEvent?.(event);
	}

	private fsyncFile(path: string): void {
		this.fsyncFileFn(path);
	}

	private fsyncDir(dir: string): void {
		this.fsyncDirFn(dir);
	}

	putRun(summary: RunRecordSummary): void {
		const runDir = runDirForSummary(this.recordsRoot, summary);
		mkdirDurable(runDir, (d) => this.fsyncDir(d));
		let acquired = false;
		try {
			this.acquireRunWriterLock(runDir);
			acquired = true;
			this.recoverRunDir(runDir);
			const runJsonPath = join(runDir, "run.json");
			const existingBytes = readFileBuffer(runJsonPath);
			let existing: RunRecordSummary | null = null;
			if (existingBytes) {
				existing = parseRunJson(existingBytes.toString("utf8"));
				if (existing.format_version > RUN_RECORD_FORMAT_VERSION) {
					throw new RecordStoreError(
						"UNSUPPORTED_FORMAT_VERSION",
						`run ${summary.id} has format_version ${existing.format_version}; writers refuse mutation`,
					);
				}
			}
			const cloned = structuredClone(summary);
			if (existing) cloned.creator = structuredClone(existing.creator);
			durableWriteFile(
				runJsonPath,
				encodeRunJson(cloned),
				(p) => this.fsyncFile(p),
				(d) => this.fsyncDir(d),
			);
		} finally {
			if (acquired) this.releaseRunWriterLock(runDir);
		}
	}

	getRun(runId: string): RunRecordSummary | null {
		const runDir = this.findRunDir(runId);
		if (!runDir) return null;
		return this.withLock(runDir, () => this.readSummary(runDir));
	}

	listRuns(filter?: { planSlug?: string }): RunRecordSummary[] {
		const rows: RunRecordSummary[] = [];
		if (!existsSync(this.recordsRoot)) return rows;
		let slugEntries: string[];
		try {
			slugEntries = readdirSync(this.recordsRoot);
		} catch {
			return rows;
		}
		for (const slug of slugEntries) {
			if (filter?.planSlug !== undefined && slug !== filter.planSlug) continue;
			const slugDir = join(this.recordsRoot, slug);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(slugDir);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;
			let runIds: string[];
			try {
				runIds = readdirSync(slugDir);
			} catch {
				continue;
			}
			for (const runId of runIds) {
				const runDir = join(slugDir, runId);
				const runJsonPath = join(runDir, "run.json");
				if (!existsSync(runJsonPath)) continue;
				try {
					const summary = this.withLock(runDir, () => this.readSummary(runDir));
					if (filter?.planSlug !== undefined) {
						if (planSlugFromPath(summary.plan_path) !== filter.planSlug) {
							continue;
						}
					}
					rows.push(summary);
				} catch (err) {
					if (
						err instanceof RecordStoreError &&
						(err.code === "RECORD_TXN_CORRUPT" ||
							err.code === "RECORD_TXN_LOCKED")
					) {
						throw err;
					}
					this.onWarn(
						`skipping unreadable run.json at ${runJsonPath}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		}
		return rows;
	}

	getLine(
		runId: string,
		stream: RecordStream,
		idempotencyKey: string,
	): RecordLine | null {
		const name = requireStream(stream);
		const runDir = this.requireRunDir(runId);
		return this.withLock(runDir, () => {
			const state = this.readStream(runDir, runId, name);
			const line = state.lines.get(idempotencyKey);
			return line ? cloneLine(line) : null;
		});
	}

	listLines(runId: string, stream: RecordStream): RecordLine[] {
		const name = requireStream(stream);
		const runDir = this.requireRunDir(runId);
		return this.withLock(runDir, () => {
			return orderedLines(this.readStream(runDir, runId, name));
		});
	}

	append(op: AppendOp): AppendResult {
		const [result] = this.atomicAppend([op]);
		if (!result) {
			throw new RecordStoreError("RUN_NOT_FOUND", `run ${op.runId} not found`);
		}
		return result;
	}

	atomicAppend(ops: AppendOp[]): AppendResult[] {
		if (ops.length === 0) return [];
		requireSingleRunAtomicAppend(ops);

		const runIds = [...new Set(ops.map((op) => op.runId))];
		const runDirs: { runId: string; runDir: string }[] = [];
		for (const runId of runIds) {
			const runDir = this.findRunDir(runId);
			if (!runDir) {
				throw new RecordStoreError("RUN_NOT_FOUND", `run ${runId} not found`);
			}
			runDirs.push({ runId, runDir });
		}
		runDirs.sort((a, b) => a.runDir.localeCompare(b.runDir));

		const acquired: string[] = [];
		let crashed = false;
		const markCrash = (): void => {
			crashed = true;
		};
		const fire = (event: TxnEvent): void => {
			try {
				this.fire(event);
			} catch (err) {
				markCrash();
				throw err;
			}
		};
		const fsyncFile = (path: string): void => {
			try {
				this.fsyncFile(path);
			} catch (err) {
				markCrash();
				throw err;
			}
		};
		const fsyncDir = (dir: string): void => {
			try {
				this.fsyncDir(dir);
			} catch (err) {
				markCrash();
				throw err;
			}
		};

		try {
			for (const { runDir } of runDirs) {
				this.acquireRunWriterLock(runDir, fire);
				acquired.push(runDir);
			}
			for (const { runDir } of runDirs) {
				this.recoverRunDir(runDir, fire, fsyncFile, fsyncDir);
			}

			const now = this.now();
			const results: AppendResult[] = [];
			const mutations: {
				runId: string;
				runDir: string;
				prepared: PreparedStream[];
			}[] = [];

			for (const { runId, runDir } of runDirs) {
				const states: Record<RecordStream, StreamState> = {
					steps: this.readStream(runDir, runId, "steps"),
					decisions: this.readStream(runDir, runId, "decisions"),
					budget: this.readStream(runDir, runId, "budget"),
				};
				const originalBytes: Record<RecordStream, Buffer | null> = {
					steps: readFileBuffer(streamPath(runDir, "steps")),
					decisions: readFileBuffer(streamPath(runDir, "decisions")),
					budget: readFileBuffer(streamPath(runDir, "budget")),
				};
				const mutated = new Set<RecordStream>();
				for (const op of ops) {
					if (op.runId !== runId) continue;
					const stream = requireStream(op.stream);
					const before = states[stream].lines.size;
					results.push(applyOp(states[stream], op, now));
					if (states[stream].lines.size !== before) mutated.add(stream);
				}
				const prepared: PreparedStream[] = [];
				for (const stream of RECORD_STREAMS) {
					if (!mutated.has(stream)) continue;
					const newText = encodeJsonlFile(orderedLines(states[stream]));
					const newBytes = Buffer.from(newText, "utf8");
					const oldBytes = originalBytes[stream];
					prepared.push({
						stream,
						created: oldBytes === null,
						newBytes,
						oldBytes,
						newSha256: sha256(newBytes),
						oldSha256: oldBytes ? sha256(oldBytes) : null,
					});
				}
				if (prepared.length > 0) {
					mutations.push({ runId, runDir, prepared });
				}
			}

			for (const { runDir, prepared } of mutations) {
				this.commitPrepared(runDir, prepared, fire, fsyncFile, fsyncDir);
			}
			return results;
		} catch (err) {
			if (!crashed) {
				for (const { runDir } of runDirs) {
					this.rollbackUncommittedStaging(runDir);
				}
			}
			throw err;
		} finally {
			if (!crashed) {
				for (const runDir of [...acquired].reverse()) {
					this.releaseRunWriterLock(runDir, fire);
				}
			}
		}
	}

	private commitPrepared(
		runDir: string,
		prepared: PreparedStream[],
		fire: (event: TxnEvent) => void,
		fsyncFile: (path: string) => void,
		fsyncDir: (dir: string) => void,
	): void {
		for (const item of prepared) {
			if (item.oldBytes) {
				writeFileSync(stagingPath(runDir, item.stream, "old"), item.oldBytes);
				fsyncFile(stagingPath(runDir, item.stream, "old"));
				fire("after-new");
			}
			writeFileSync(stagingPath(runDir, item.stream, "new"), item.newBytes);
			fsyncFile(stagingPath(runDir, item.stream, "new"));
			fire("after-new");
		}
		fsyncDir(runDir);
		fire("after-dirsync:staging");

		const journal: JournalDoc = {
			version: 1,
			streams: prepared.map((p) => p.stream),
			created: Object.fromEntries(prepared.map((p) => [p.stream, p.created])),
			new_sha256: Object.fromEntries(
				prepared.map((p) => [p.stream, p.newSha256]),
			),
			old_sha256: Object.fromEntries(
				prepared
					.filter((p) => p.oldSha256)
					.map((p) => [p.stream, p.oldSha256 as string]),
			),
		};
		const journalBytes = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
		const journalSha = sha256(journalBytes);
		durableWriteFile(journalPath(runDir), journalBytes, fsyncFile, fsyncDir);
		fire("after-prepared");
		fire("after-dirsync:prepared");

		const commitBytes = Buffer.from(
			`${JSON.stringify({ version: 1, journal_sha256: journalSha } satisfies CommitDoc)}\n`,
			"utf8",
		);
		durableWriteFile(commitPath(runDir), commitBytes, fsyncFile, fsyncDir);
		fire("after-commit-marker");
		fire("after-dirsync:commit");

		for (const item of prepared) {
			renameSync(
				stagingPath(runDir, item.stream, "new"),
				streamPath(runDir, item.stream),
			);
			fsyncDir(runDir);
			fire(`after-rename:${item.stream}`);
			fire(`after-dirsync:rename:${item.stream}`);
		}

		for (const item of prepared) {
			unlinkQuiet(stagingPath(runDir, item.stream, "old"));
		}
		fsyncDir(runDir);
		unlinkQuiet(journalPath(runDir));
		unlinkQuiet(commitPath(runDir));
		fsyncDir(runDir);
		fire("after-dirsync:cleanup");
	}

	private rollbackUncommittedStaging(runDir: string): void {
		if (!existsSync(runDir)) return;
		if (existsSync(commitPath(runDir))) return;
		for (const stream of RECORD_STREAMS) {
			unlinkQuiet(stagingPath(runDir, stream, "new"));
			unlinkQuiet(stagingPath(runDir, stream, "old"));
		}
		unlinkQuiet(journalPath(runDir));
		unlinkQuiet(`${journalPath(runDir)}.tmp`);
		unlinkQuiet(`${commitPath(runDir)}.tmp`);
		try {
			this.fsyncDir(runDir);
		} catch {
			// Best-effort; originals were never replaced.
		}
	}

	private withLock<T>(runDir: string, fn: () => T): T {
		this.acquireRunWriterLock(runDir);
		try {
			this.recoverRunDir(runDir);
			return fn();
		} finally {
			this.releaseRunWriterLock(runDir);
		}
	}

	/**
	 * Acquire/steal `.txn.lock`, run journal recovery, and release.
	 * Doctor uses this for absent/stale locks; live and malformed
	 * publication-window locks must be skipped by the caller.
	 */
	recoverAbandoned(runDir: string): void {
		this.withLock(runDir, () => undefined);
	}

	private findRunDir(runId: string): string | null {
		if (!existsSync(this.recordsRoot)) return null;
		let slugs: string[];
		try {
			slugs = readdirSync(this.recordsRoot);
		} catch {
			return null;
		}
		for (const slug of slugs) {
			const runDir = join(this.recordsRoot, slug, runId);
			if (existsSync(join(runDir, "run.json"))) return runDir;
		}
		return null;
	}

	private requireRunDir(runId: string): string {
		const runDir = this.findRunDir(runId);
		if (!runDir) {
			throw new RecordStoreError("RUN_NOT_FOUND", `run ${runId} not found`);
		}
		return runDir;
	}

	private readSummary(runDir: string): RunRecordSummary {
		const bytes = readFileBuffer(join(runDir, "run.json"));
		if (!bytes) {
			throw new RecordStoreError(
				"RUN_NOT_FOUND",
				`run.json missing in ${runDir}`,
			);
		}
		return parseRunJson(bytes.toString("utf8"));
	}

	private readStream(
		runDir: string,
		runId: string,
		stream: RecordStream,
	): StreamState {
		const bytes = readFileBuffer(streamPath(runDir, stream));
		if (!bytes) return emptyStream();
		return streamFromLines(decodeJsonlFile(bytes.toString("utf8"), runId));
	}

	private acquireRunWriterLock(
		runDir: string,
		fire: (event: TxnEvent) => void = (e) => this.fire(e),
	): void {
		const dest = lockPath(runDir);
		const key = resolve(runDir);
		const deadline = Date.now() + this.lockTimeoutMs;
		let malformedSince: number | null = null;
		let liveWaitSince: number | null = null;
		let liveWaitPid: number | null = null;

		const owner = randomBytes(16).toString("hex");
		while (true) {
			if (Date.now() > deadline && liveWaitSince !== null) {
				throw new RecordStoreError(
					"RECORD_TXN_LOCKED",
					`run ${runDir} record writer lock held by pid ${liveWaitPid}`,
				);
			}

			const temp = join(
				runDir,
				`${LOCK_NAME}.${randomBytes(16).toString("hex")}`,
			);
			const doc: LockDoc = {
				version: 1,
				pid: process.pid,
				owner,
				started_at: new Date().toISOString(),
			};
			writeFileSync(temp, `${JSON.stringify(doc)}\n`);
			this.fsyncFile(temp);
			fire("after-lock-temp-written");

			try {
				linkSync(temp, dest);
			} catch (err) {
				unlinkQuiet(temp);
				if (isErrno(err, "EXDEV") || isErrno(err, "EPERM")) {
					throw new RecordStoreError(
						"RECORD_TXN_LOCKED",
						`hard-link unsupported for record lock (${(err as { code: string }).code})`,
					);
				}
				if (isErrno(err, "ENOENT")) continue;
				if (!isErrno(err, "EEXIST")) throw err;

				let existingText: string | null = null;
				try {
					existingText = readFileSync(dest, "utf8");
				} catch (readErr) {
					if (isErrno(readErr, "ENOENT")) {
						malformedSince = null;
						liveWaitSince = null;
						continue;
					}
					existingText = null;
				}
				const parsed =
					existingText === null ? null : parseLockDoc(existingText);
				if (parsed) {
					malformedSince = null;
					const mapped = LOCK_OWNERS.get(key);
					if (
						parsed.pid === process.pid &&
						mapped &&
						mapped.owner === parsed.owner
					) {
						mapped.depth += 1;
						unlinkQuiet(temp);
						return;
					}
					if (isPidAlive(parsed.pid)) {
						if (liveWaitSince === null || liveWaitPid !== parsed.pid) {
							liveWaitSince = Date.now();
							liveWaitPid = parsed.pid;
						}
						if (Date.now() - liveWaitSince >= this.lockTimeoutMs) {
							throw new RecordStoreError(
								"RECORD_TXN_LOCKED",
								`run ${runDir} record writer lock held by pid ${parsed.pid}`,
							);
						}
						Bun.sleepSync(this.lockPollMs);
						continue;
					}
					unlinkQuiet(dest);
					this.fsyncDir(runDir);
					liveWaitSince = null;
					continue;
				}

				if (malformedSince === null) malformedSince = Date.now();
				if (Date.now() - malformedSince >= this.lockTimeoutMs) {
					unlinkQuiet(dest);
					this.fsyncDir(runDir);
					malformedSince = null;
					continue;
				}
				Bun.sleepSync(this.lockPollMs);
				continue;
			}

			this.fsyncDir(runDir);
			fire("after-lock-linked");
			unlinkQuiet(temp);
			this.fsyncDir(runDir);
			LOCK_OWNERS.set(key, { pid: process.pid, owner, depth: 1 });
			this.cleanupLockTemps(runDir);
			fire("after-lock-acquired");
			return;
		}
	}

	private releaseRunWriterLock(
		runDir: string,
		fire: (event: TxnEvent) => void = (e) => this.fire(e),
	): void {
		const key = resolve(runDir);
		const mapped = LOCK_OWNERS.get(key);
		if (!mapped) return;
		mapped.depth -= 1;
		if (mapped.depth > 0) return;
		const dest = lockPath(runDir);
		try {
			const text = readFileSync(dest, "utf8");
			const parsed = parseLockDoc(text);
			if (
				parsed &&
				parsed.pid === mapped.pid &&
				parsed.owner === mapped.owner
			) {
				unlinkQuiet(dest);
				this.fsyncDir(runDir);
			}
		} catch (err) {
			if (!isErrno(err, "ENOENT")) throw err;
		}
		LOCK_OWNERS.delete(key);
		fire("after-lock-released");
	}

	private cleanupLockTemps(runDir: string): void {
		let names: string[];
		try {
			names = readdirSync(runDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.startsWith(`${LOCK_NAME}.`)) continue;
			if (name === LOCK_NAME) continue;
			unlinkQuiet(join(runDir, name));
		}
	}

	private recoverRunDir(
		runDir: string,
		fire: (event: TxnEvent) => void = (e) => this.fire(e),
		fsyncFile: (path: string) => void = (p) => this.fsyncFile(p),
		fsyncDir: (dir: string) => void = (d) => this.fsyncDir(d),
	): void {
		void fsyncFile;
		const jp = journalPath(runDir);
		const cp = commitPath(runDir);
		const journalBytes = readFileBuffer(jp);
		const commitBytes = readFileBuffer(cp);
		const commitExists = commitBytes !== null || existsSync(cp);

		const stagingPresent = RECORD_STREAMS.some(
			(stream) =>
				existsSync(stagingPath(runDir, stream, "new")) ||
				existsSync(stagingPath(runDir, stream, "old")),
		);
		if (journalBytes || commitBytes || commitExists || stagingPresent) {
			fire("during-recovery");
		}

		if (!journalBytes && !commitExists) {
			this.deleteOrphanStaging(runDir);
			fsyncDir(runDir);
			return;
		}

		const journal =
			journalBytes !== null
				? parseJournalDoc(journalBytes.toString("utf8"))
				: null;
		const journalOk =
			journal !== null &&
			journalChecksumsMatch(runDir, journal) &&
			noUnexpectedStaging(runDir, journal);
		const commit =
			commitBytes !== null
				? parseCommitDoc(commitBytes.toString("utf8"))
				: null;
		const journalSha = journalBytes ? sha256(journalBytes) : null;
		const commitOk =
			commit !== null &&
			journalSha !== null &&
			commit.journal_sha256 === journalSha;

		if (!journalOk || (commitExists && !commitOk)) {
			throw new RecordStoreError(
				"RECORD_TXN_CORRUPT",
				`corrupt record transaction in ${runDir}`,
			);
		}

		if (journalOk && commitOk && journal) {
			this.rollForward(runDir, journal, fire, fsyncDir);
			return;
		}

		if (journalOk && !commitExists && journal) {
			if (rollbackProofHolds(runDir, journal)) {
				this.rollBack(runDir, journal, fsyncDir);
				return;
			}
			if (fullyAppliedWithoutCommit(runDir, journal)) {
				this.cleanupAfterForward(runDir, journal, fsyncDir);
				return;
			}
			throw new RecordStoreError(
				"RECORD_TXN_CORRUPT",
				`incomplete record transaction in ${runDir}`,
			);
		}
	}

	private rollForward(
		runDir: string,
		journal: JournalDoc,
		fire: (event: TxnEvent) => void,
		fsyncDir: (dir: string) => void,
	): void {
		for (const stream of journal.streams) {
			if (existsSync(stagingPath(runDir, stream, "new"))) continue;
			if (!liveMatchesNewSha(runDir, journal, stream)) {
				throw new RecordStoreError(
					"RECORD_TXN_CORRUPT",
					`committed stream ${stream} missing replacement in ${runDir}`,
				);
			}
		}
		for (const stream of journal.streams) {
			const neu = stagingPath(runDir, stream, "new");
			if (existsSync(neu)) {
				const bytes = readFileBuffer(neu);
				if (!bytes || sha256(bytes) !== journal.new_sha256[stream]) {
					throw new RecordStoreError(
						"RECORD_TXN_CORRUPT",
						`corrupt staging for ${stream} in ${runDir}`,
					);
				}
				renameSync(neu, streamPath(runDir, stream));
				fsyncDir(runDir);
				fire(`after-rename:${stream}`);
				fire(`after-dirsync:rename:${stream}`);
			}
		}
		this.cleanupAfterForward(runDir, journal, fsyncDir);
	}

	private rollBack(
		runDir: string,
		journal: JournalDoc,
		fsyncDir: (dir: string) => void,
	): void {
		for (const stream of journal.streams) {
			unlinkQuiet(stagingPath(runDir, stream, "new"));
			unlinkQuiet(stagingPath(runDir, stream, "old"));
		}
		unlinkQuiet(journalPath(runDir));
		fsyncDir(runDir);
	}

	private cleanupAfterForward(
		runDir: string,
		journal: JournalDoc,
		fsyncDir: (dir: string) => void,
	): void {
		for (const stream of journal.streams) {
			unlinkQuiet(stagingPath(runDir, stream, "old"));
		}
		unlinkQuiet(journalPath(runDir));
		unlinkQuiet(commitPath(runDir));
		fsyncDir(runDir);
	}

	private deleteOrphanStaging(runDir: string): void {
		for (const stream of RECORD_STREAMS) {
			unlinkQuiet(stagingPath(runDir, stream, "new"));
			unlinkQuiet(stagingPath(runDir, stream, "old"));
		}
		try {
			for (const name of readdirSync(runDir)) {
				if (name.endsWith(".tmp") && !name.startsWith(`${LOCK_NAME}.`)) {
					unlinkQuiet(join(runDir, name));
				}
			}
		} catch {
			// ignore
		}
	}
}

export function createWorkingTreeRecordStore(
	opts: WorkingTreeRecordStoreOptions,
): RecordStore {
	return new WorkingTreeRecordStore(opts);
}

/**
 * Lock-held recovery for an abandoned per-run transaction. Acquires or
 * steals `.txn.lock`, runs the same recovery as store open/read/append,
 * and releases in `finally`. `RECORD_TXN_CORRUPT` leaves artifacts in
 * place. Callers must not invoke this for live or malformed locks.
 */
export function recoverAbandonedRunDir(
	runDir: string,
	opts: Omit<WorkingTreeRecordStoreOptions, "recordsRoot"> = {},
): void {
	const store = new WorkingTreeRecordStore({
		recordsRoot: resolve(runDir),
		...opts,
	});
	store.recoverAbandoned(runDir);
}
