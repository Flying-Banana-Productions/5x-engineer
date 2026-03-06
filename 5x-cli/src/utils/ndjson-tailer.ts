/**
 * NdjsonTailer — cross-runtime file tailer for NDJSON log directories.
 *
 * Watches a directory for `agent-*.ndjson` files, tails them concurrently,
 * and yields parsed JSON entries as they're appended. Uses a hybrid approach:
 * `fs.watch` for low-latency notification + interval polling as fallback.
 *
 * Design constraints:
 * - Zero external dependencies, `node:fs` only (no Bun-specific APIs)
 * - Bounded reads: 64KB chunks, not unbounded allocation
 * - Bounded partial-line buffers: 1MB cap per file
 * - Buffer-based newline scanning for UTF-8 correctness
 * - Deterministically testable via `poll()` method + `pollInterval: 0`
 */

import {
	closeSync,
	type FSWatcher,
	openSync,
	readdirSync,
	readSync,
	statSync,
	watch,
} from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TailerOptions {
	/** Directory to watch for *.ndjson files. */
	dir: string;
	/** Poll interval in ms (default: 250). Set to 0 to disable auto-polling (test mode). */
	pollInterval?: number;
	/** AbortSignal for cleanup. */
	signal: AbortSignal;
	/** Start at current EOF instead of reading existing content. */
	startAtEnd?: boolean;
}

export interface TaggedLine {
	/** Filename within the directory (e.g., "agent-001.ndjson"). */
	file: string;
	/** Parsed JSON entry (the raw log line with ts, type, and event fields). */
	entry: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to read per file per poll tick. */
const MAX_CHUNK_SIZE = 64 * 1024; // 64KB

/** Maximum partial-line buffer size per file before forced discard. */
const MAX_LINE_BUFFER = 1024 * 1024; // 1MB

/** File pattern to match. */
const FILE_PATTERN = /^agent-\d+\.ndjson$/;

// ---------------------------------------------------------------------------
// Per-file state
// ---------------------------------------------------------------------------

interface FileState {
	offset: number;
	/** Partial line buffer (bytes before a complete newline). */
	lineBuf: Buffer;
}

// ---------------------------------------------------------------------------
// NdjsonTailer
// ---------------------------------------------------------------------------

export class NdjsonTailer {
	private readonly dir: string;
	private readonly files = new Map<string, FileState>();
	private watcher: FSWatcher | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private aborted = false;

	// Async iterator support
	private pending: TaggedLine[] = [];
	private resolve: ((value: IteratorResult<TaggedLine>) => void) | null = null;
	private done = false;

	constructor(opts: TailerOptions) {
		this.dir = opts.dir;

		// Skip existing content BEFORE setting up watchers (avoids race condition
		// where fs.watch fires and reads content at offset 0 before skipToEnd runs)
		if (opts.startAtEnd) {
			this.skipToEnd();
		}

		// Set up fs.watch for acceleration (best-effort)
		try {
			this.watcher = watch(this.dir, () => {
				if (!this.aborted) this.drainPoll();
			});
			this.watcher.on("error", () => {
				// Silently degrade — interval polling continues
			});
		} catch {
			// fs.watch may throw on unsupported platforms — rely on interval
		}

		// Set up interval polling (unless disabled for testing)
		const interval = opts.pollInterval ?? 250;
		if (interval > 0) {
			this.interval = setInterval(() => {
				if (!this.aborted) this.drainPoll();
			}, interval);
		}

		// Wire abort signal
		opts.signal.addEventListener("abort", () => this.cleanup(), { once: true });
	}

	/**
	 * Synchronous poll: scan directory, read new bytes from all files,
	 * return any complete parsed lines. Exposed for deterministic testing.
	 */
	poll(): TaggedLine[] {
		if (this.aborted) return [];

		const results: TaggedLine[] = [];

		// Discover files
		let entries: string[];
		try {
			entries = readdirSync(this.dir).filter((f) => FILE_PATTERN.test(f));
		} catch {
			return results; // dir may not exist yet
		}

		// Sort to ensure deterministic ordering (agent-001 before agent-002)
		entries.sort();

		for (const file of entries) {
			const filePath = `${this.dir}/${file}`;

			// Get or create file state
			let state = this.files.get(file);
			if (!state) {
				state = { offset: 0, lineBuf: Buffer.alloc(0) };
				this.files.set(file, state);
			}

			// Stat the file
			let size: number;
			try {
				size = statSync(filePath).size;
			} catch {
				continue; // file may have been removed
			}

			// Handle truncation
			if (size < state.offset) {
				state.offset = 0;
				state.lineBuf = Buffer.alloc(0);
			}

			// Nothing new
			if (size <= state.offset) continue;

			// Read new bytes in bounded chunks
			let fd: number;
			try {
				fd = openSync(filePath, "r");
			} catch {
				continue;
			}

			try {
				const readBuf = Buffer.alloc(
					Math.min(MAX_CHUNK_SIZE, size - state.offset),
				);
				while (state.offset < size && !this.aborted) {
					const toRead = Math.min(MAX_CHUNK_SIZE, size - state.offset);
					const buf =
						toRead === readBuf.length ? readBuf : Buffer.alloc(toRead);
					const bytesRead = readSync(fd, buf, 0, toRead, state.offset);
					if (bytesRead === 0) break;

					state.offset += bytesRead;

					// Scan for newlines (0x0a) in the read buffer
					let lineStart = 0;
					for (let i = 0; i < bytesRead; i++) {
						if (buf[i] === 0x0a) {
							const lineChunk = buf.subarray(lineStart, i);
							const fullLine =
								state.lineBuf.length > 0
									? Buffer.concat([state.lineBuf, lineChunk])
									: lineChunk;
							state.lineBuf = Buffer.alloc(0);

							// Parse the complete line
							const parsed = this.parseLine(fullLine, file);
							if (parsed) results.push(parsed);

							lineStart = i + 1;
						}
					}

					// Buffer remaining partial line
					if (lineStart < bytesRead) {
						const remainder = buf.subarray(lineStart, bytesRead);
						state.lineBuf =
							state.lineBuf.length > 0
								? Buffer.concat([state.lineBuf, remainder])
								: Buffer.from(remainder);
					}

					// Check partial-line buffer cap
					if (state.lineBuf.length > MAX_LINE_BUFFER) {
						process.stderr.write(
							`[watch] Warning: partial line buffer exceeded ${MAX_LINE_BUFFER} bytes for ${file}, discarding\n`,
						);
						state.lineBuf = Buffer.alloc(0);
					}
				}
			} finally {
				closeSync(fd);
			}
		}

		return results;
	}

	/**
	 * Set initial file offsets to current EOF (skip existing content).
	 * Call before starting iteration to implement --no-replay.
	 */
	skipToEnd(): void {
		let entries: string[];
		try {
			entries = readdirSync(this.dir).filter((f) => FILE_PATTERN.test(f));
		} catch {
			return;
		}

		for (const file of entries) {
			const filePath = `${this.dir}/${file}`;
			try {
				const size = statSync(filePath).size;
				this.files.set(file, { offset: size, lineBuf: Buffer.alloc(0) });
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Async iterator interface — yields TaggedLine entries as they appear.
	 */
	async *[Symbol.asyncIterator](): AsyncIterableIterator<TaggedLine> {
		// Do an initial poll to pick up existing content
		this.drainPoll();

		while (!this.done) {
			// Yield any buffered lines
			while (this.pending.length > 0) {
				const line = this.pending.shift();
				if (line) yield line;
			}

			if (this.done) break;

			// Wait for next poll to produce lines
			yield* await new Promise<TaggedLine[]>((resolve) => {
				// If we already have pending lines (from a poll that fired between
				// the while check and here), resolve immediately
				if (this.pending.length > 0 || this.done) {
					const lines = this.pending.splice(0);
					resolve(lines);
					return;
				}

				this.resolve = (result) => {
					if (result.done) {
						resolve([]);
					} else {
						resolve([result.value, ...this.pending.splice(0)]);
					}
				};
			});
		}
	}

	/** Cleanup resources. */
	destroy(): void {
		this.cleanup();
	}

	// -------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------

	/** Run poll() and push results into the async iterator pipeline. */
	private drainPoll(): void {
		const lines = this.poll();
		if (lines.length === 0) return;

		if (this.resolve) {
			// Iterator is waiting — wake it up with the first line
			const first = lines[0] as TaggedLine;
			const r = this.resolve;
			this.resolve = null;
			this.pending.push(...lines.slice(1));
			r({ value: first, done: false });
		} else {
			this.pending.push(...lines);
		}
	}

	/** Parse a complete line buffer into a TaggedLine. */
	private parseLine(buf: Buffer, file: string): TaggedLine | null {
		if (buf.length === 0) return null;
		const text = buf.toString("utf-8");
		try {
			const entry = JSON.parse(text) as Record<string, unknown>;
			if (typeof entry !== "object" || entry === null) return null;
			return { file, entry };
		} catch {
			process.stderr.write(
				`[watch] Warning: malformed JSON in ${file}, skipping line\n`,
			);
			return null;
		}
	}

	/** Clean up watcher, interval, and signal iterator completion. */
	private cleanup(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.done = true;

		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		// Wake up any waiting iterator
		if (this.resolve) {
			const r = this.resolve;
			this.resolve = null;
			r({ value: undefined as unknown as TaggedLine, done: true });
		}
	}
}
