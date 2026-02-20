/**
 * Streaming word-wrap writer for headless console output.
 *
 * Buffers tokens at word boundaries, inserts newlines when a word would
 * overflow terminal width, and manages ANSI dim/reset for style transitions.
 * Fenced code blocks (``` delimiters) pass through verbatim (no wrapping).
 *
 * All dependencies (writer function, ANSI config, width) are injectable
 * for testability.
 */

import { type AnsiConfig, resolveAnsi } from "./ansi.js";

export interface StreamWriterOptions {
	width?: number;
	writer?: (s: string) => void;
	ansi?: AnsiConfig;
}

type Style = "text" | "thinking" | "idle";

export class StreamWriter {
	private col = 0;
	private wordBuf = "";
	/** Buffered whitespace — only emitted when the next word fits on the current line. */
	private spaceBuf = "";
	private style: Style = "idle";
	private width: number;
	private inFence = false;
	private ansi: AnsiConfig;
	private write: (s: string) => void;
	/** Tracks content of the current line for fence detection on newline. */
	private lineBuf = "";

	constructor(opts?: StreamWriterOptions) {
		this.width = opts?.width ?? process.stdout.columns ?? 80;
		this.write = opts?.writer ?? ((s: string) => process.stdout.write(s));
		this.ansi = opts?.ansi ?? resolveAnsi();
	}

	/** Stream agent text with word wrapping. */
	writeText(delta: string): void {
		this.setStyle("text");
		this.streamDelta(delta);
	}

	/** Stream thinking/reasoning text with dim styling and word wrapping. */
	writeThinking(delta: string): void {
		this.setStyle("thinking");
		this.streamDelta(delta);
	}

	/** Write a single complete line, truncated to width. Flushes any in-progress streaming first. */
	writeLine(text: string, opts?: { dim?: boolean }): void {
		this.endBlock();
		const truncated = this.truncate(text);
		if (opts?.dim) {
			this.write(`${this.ansi.dim}${truncated}${this.ansi.reset}\n`);
		} else {
			this.write(`${truncated}\n`);
		}
	}

	/** Flush word buffer, terminate current line if needed, reset style. */
	endBlock(): void {
		this.flushWord();
		// Emit any pending whitespace (only discarded on wrap).
		if (this.spaceBuf.length > 0) {
			this.write(this.spaceBuf);
			this.col += this.spaceBuf.length;
			this.lineBuf += this.spaceBuf;
			this.spaceBuf = "";
		}
		if (this.col > 0) {
			this.write("\n");
			this.col = 0;
			this.lineBuf = "";
		}
		if (this.style === "thinking") {
			this.write(this.ansi.reset);
		}
		this.style = "idle";
	}

	/** Final cleanup. */
	destroy(): void {
		this.endBlock();
	}

	// -------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------

	private setStyle(next: Style): void {
		if (this.style === next) return;

		// Reset previous style if needed
		if (this.style === "thinking") {
			this.write(this.ansi.reset);
		}

		// Apply new style
		if (next === "thinking") {
			this.write(this.ansi.dim);
		}

		this.style = next;
	}

	private streamDelta(delta: string): void {
		for (const ch of delta) {
			if (ch === "\n") {
				this.flushWord();
				this.spaceBuf = "";
				this.checkFence();
				this.write("\n");
				this.col = 0;
				this.lineBuf = "";
			} else if (ch === " " || ch === "\t") {
				this.flushWord();
				this.spaceBuf += ch;
			} else {
				this.wordBuf += ch;
			}
		}
	}

	private flushWord(): void {
		if (this.wordBuf.length === 0) {
			// No word to flush — but if we have pending space and are inside
			// a fence, emit it immediately (fences preserve all whitespace).
			if (this.inFence && this.spaceBuf.length > 0) {
				this.write(this.spaceBuf);
				this.col += this.spaceBuf.length;
				this.lineBuf += this.spaceBuf;
				this.spaceBuf = "";
			}
			return;
		}

		const spaceLen = this.spaceBuf.length;
		const wordLen = this.wordBuf.length;

		if (this.inFence) {
			// Inside a fenced code block — emit space + word verbatim, no wrap check.
			if (spaceLen > 0) {
				this.write(this.spaceBuf);
				this.col += spaceLen;
				this.lineBuf += this.spaceBuf;
			}
			this.write(this.wordBuf);
			this.col += wordLen;
			this.lineBuf += this.wordBuf;
		} else if (this.col === 0) {
			// Start of line — emit space (preserving leading whitespace) + word.
			if (spaceLen > 0) {
				this.write(this.spaceBuf);
				this.col += spaceLen;
				this.lineBuf += this.spaceBuf;
			}
			this.write(this.wordBuf);
			this.col += wordLen;
			this.lineBuf += this.wordBuf;
		} else if (this.col + spaceLen + wordLen > this.width) {
			// Word (with preceding space) would overflow — wrap.
			// Discard the trailing space on the current line.
			this.write("\n");
			this.col = 0;
			this.lineBuf = "";
			this.write(this.wordBuf);
			this.col = wordLen;
			this.lineBuf = this.wordBuf;
		} else {
			// Fits — emit space + word.
			if (spaceLen > 0) {
				this.write(this.spaceBuf);
				this.col += spaceLen;
				this.lineBuf += this.spaceBuf;
			}
			this.write(this.wordBuf);
			this.col += wordLen;
			this.lineBuf += this.wordBuf;
		}

		this.spaceBuf = "";
		this.wordBuf = "";
	}

	private checkFence(): void {
		if (this.lineBuf.trimStart().startsWith("```")) {
			this.inFence = !this.inFence;
		}
	}

	private truncate(text: string): string {
		if (text.length <= this.width) return text;
		// Leave room for "..."
		return `${text.slice(0, this.width - 3)}...`;
	}
}
