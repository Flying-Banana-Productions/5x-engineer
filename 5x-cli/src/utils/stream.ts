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
 *
 * Guards against already-finished or destroyed streams: if writableFinished or
 * destroyed is already set, 'finish'/'error' will never fire and the Promise
 * would hang — so we resolve immediately in those cases.
 */
export function endStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise<void>((resolve) => {
		// Cast to access Writable-specific state flags (writableFinished, destroyed).
		// NodeJS.WritableStream is minimal; fs.WriteStream and stream.Writable both
		// expose these fields at runtime even when the static type omits them.
		const ws = stream as { writableFinished?: boolean; destroyed?: boolean };
		if (ws.writableFinished || ws.destroyed) {
			resolve();
			return;
		}
		stream.once("finish", resolve);
		stream.once("error", () => resolve()); // non-throwing: errors → resolve
		stream.end();
	});
}
