/**
 * Lossless stdout for the CLI entry point.
 *
 * Bun's `console.log` drops everything past the pipe buffer (~64 KiB) once
 * stdout has been switched to non-blocking mode — which merely touching parts
 * of `process.stdout` does — so large JSON envelopes arrive truncated at a
 * piped consumer. Writing synchronously and retrying on EAGAIN delivers every
 * byte, including on `process.exit()` paths and with a slow reader.
 */

import { writeSync } from "node:fs";
import { format } from "node:util";

export interface WriteAllSyncDeps {
	write?: (
		fd: number,
		bytes: Uint8Array,
		offset: number,
		length: number,
	) => number;
	/** Back off while a non-blocking pipe is full. */
	wait?: () => void;
}

function errnoCode(err: unknown): string | undefined {
	return (err as { code?: string } | null)?.code;
}

/**
 * Write all of `text` to `fd`, looping over partial writes. A closed reader
 * (EPIPE) silently discards the remainder, matching `console.log`.
 */
export function writeAllSync(
	fd: number,
	text: string,
	deps: WriteAllSyncDeps = {},
): void {
	const write = deps.write ?? writeSync;
	const wait = deps.wait ?? (() => Bun.sleepSync(1));
	const bytes = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += write(fd, bytes, offset, bytes.length - offset);
		} catch (err) {
			const code = errnoCode(err);
			if (code === "EAGAIN") {
				wait();
				continue;
			}
			if (code === "EPIPE") return;
			throw err;
		}
	}
}

/**
 * Route `console.log` through {@link writeAllSync}. Call once from the CLI
 * entry point only: tests silence and spy on `console.log` directly.
 */
export function installLosslessConsoleLog(): void {
	console.log = (...args: unknown[]) => {
		const text = `${format(...args)}\n`;
		// Stay behind anything already queued on the stream to preserve order.
		if (process.stdout.writableLength > 0) {
			process.stdout.write(text);
			return;
		}
		writeAllSync(1, text);
	};
}
