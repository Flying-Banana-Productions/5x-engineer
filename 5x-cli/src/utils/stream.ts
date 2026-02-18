/**
 * Shared stream utilities for log file management.
 */

/**
 * Promisified end — resolves once the write stream has flushed to disk.
 * Non-throwing: errors during close are suppressed (stream errors should be
 * handled by the caller-attached 'error' listener on stream creation).
 */
export function endStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise((resolve) => {
		stream.end(() => resolve());
		stream.once("error", () => resolve());
	});
}
