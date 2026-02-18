/**
 * Shared stream utilities for log file management.
 */

/**
 * Promisified end — resolves once the write stream has flushed to disk.
 *
 * Non-throwing: stream errors resolve rather than reject (errors should be
 * handled by the caller-attached 'error' listener registered at stream creation).
 *
 * Listeners are attached BEFORE calling end() to avoid a race where end()
 * emits 'error' or 'finish' synchronously before we register the handler.
 * once() prevents listener accumulation if called multiple times on the same stream.
 */
export function endStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise<void>((resolve) => {
		stream.once("finish", resolve);
		stream.once("error", () => resolve()); // non-throwing: errors → resolve
		stream.end();
	});
}
