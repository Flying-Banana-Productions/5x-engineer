/**
 * Permission policy handling for TUI and headless modes.
 *
 * Phase 3 of 004-impl-5x-cli-tui.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type PermissionPolicy =
	| { mode: "auto-approve-all" }
	| { mode: "tui-native" }
	| { mode: "workdir-scoped"; workdir: string };

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface PermissionHandler {
	/** Start listening for permission requests according to the policy. */
	start(): void;
	/** Stop listening for permission requests. */
	stop(): void;
}

function tracePermission(
	trace: ((event: string, data?: unknown) => void) | undefined,
	event: string,
	data?: unknown,
): void {
	try {
		trace?.(`permission.${event}`, data);
	} catch {
		// Never fail permission handling due to debug tracing.
	}
}

// ---------------------------------------------------------------------------
// Error message for non-interactive mode without explicit flag
// ---------------------------------------------------------------------------

export const NON_INTERACTIVE_NO_FLAG_ERROR =
	"Error: 5x is running non-interactively but no permission policy was specified.\n" +
	"  Use --ci (or --auto where supported) to auto-approve all tool permissions, or\n" +
	"  ensure stdin is a TTY for interactive mode.";

// ---------------------------------------------------------------------------
// Policy implementation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a path is within the workdir scope.
 * Handles relative paths, absolute paths, and path traversal.
 *
 * Security: Resolves all paths to absolute paths and normalizes them
 * to prevent path traversal attacks (e.g., "../..", "/project/../etc/passwd").
 */
function isPathInWorkdir(path: string, workdir: string): boolean {
	const resolveWithFilesystemLinks = (inputPath: string): string => {
		const absolute = resolve(inputPath);

		let probe = absolute;
		const tail: string[] = [];
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) break;
			tail.unshift(probe.slice(parent.length + 1));
			probe = parent;
		}

		let base = probe;
		try {
			base = realpathSync(probe);
		} catch {
			// Fall back to unresolved absolute path
		}

		return tail.length > 0 ? resolve(base, ...tail) : base;
	};

	// Resolve path segments and symlinks to prevent symlink escapes.
	const resolvedPath = resolveWithFilesystemLinks(resolve(workdir, path));
	const resolvedWorkdir = resolveWithFilesystemLinks(resolve(workdir));

	// Normalize paths for comparison (handle backslashes on Windows)
	const normalizedPath = resolvedPath.replace(/\\/g, "/").replace(/\/+/g, "/");
	const normalizedWorkdir = resolvedWorkdir
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/");

	// Remove trailing slash from workdir for comparison
	const workdirBase = normalizedWorkdir.endsWith("/")
		? normalizedWorkdir.slice(0, -1)
		: normalizedWorkdir;

	// Check if resolved path is within workdir
	return (
		normalizedPath === workdirBase ||
		normalizedPath.startsWith(`${workdirBase}/`)
	);
}

/**
 * Extract path from permission request arguments.
 * Different tools have different argument structures.
 */
function extractPathFromArgs(
	tool: string,
	args: Record<string, unknown>,
): string | undefined {
	switch (tool) {
		case "fs_read":
		case "fs_write":
		case "fs_edit":
			return typeof args.path === "string" ? args.path : undefined;
		case "bash":
			// For bash commands, we can't reliably extract paths
			return undefined;
		default:
			return undefined;
	}
}

function isPermissionRequestEvent(event: {
	type?: string;
	properties?: Record<string, unknown>;
}): boolean {
	return (
		event.type === "permission.asked" || event.type === "permission.updated"
	);
}

function getPermissionRequestId(event: {
	properties?: Record<string, unknown>;
}): string | undefined {
	const props = event.properties as Record<string, unknown> | undefined;
	const id = props?.id ?? props?.requestID ?? props?.requestId;
	return typeof id === "string" ? id : undefined;
}

function getPermissionPatterns(event: {
	properties?: Record<string, unknown>;
}): string[] {
	const patterns = (event.properties as Record<string, unknown> | undefined)
		?.patterns;
	if (!Array.isArray(patterns)) return [];
	return patterns.filter((value): value is string => typeof value === "string");
}

function isScopedFilePermission(permission: string | undefined): boolean {
	return (
		permission === "read" ||
		permission === "edit" ||
		permission === "glob" ||
		permission === "grep" ||
		permission === "list"
	);
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

/**
 * Create a handler that auto-approves all permission requests immediately.
 */
function createAutoApproveHandler(
	client: OpencodeClient,
	trace?: (event: string, data?: unknown) => void,
): PermissionHandler {
	let unsubscribe: (() => void) | undefined;

	return {
		start() {
			tracePermission(trace, "auto.start");
			// Subscribe to permission requests and auto-approve them
			const abortController = new AbortController();

			(async () => {
				try {
					const { stream } = await client.event.subscribe(undefined, {
						signal: abortController.signal,
					});
					for await (const event of stream) {
						if (abortController.signal.aborted) break;

						// Check if this is a permission request event
						const requestId = getPermissionRequestId(event);
						if (isPermissionRequestEvent(event) && requestId) {
							tracePermission(trace, "auto.request", { requestId });
							// Auto-approve the permission
							try {
								await client.permission.reply({
									requestID: requestId,
									reply: "once",
								});
								tracePermission(trace, "auto.reply", {
									requestId,
									reply: "once",
								});
							} catch {
								// Ignore errors — permission may have timed out
							}
						}
					}
				} catch {
					// Stream errors are expected on abort
				}
			})();

			unsubscribe = () => {
				tracePermission(trace, "auto.stop");
				abortController.abort();
			};
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}

/**
 * Create a no-op handler for TUI-native mode.
 * The TUI handles permissions natively; we don't need to do anything.
 */
function createTuiNativeHandler(
	trace?: (event: string, data?: unknown) => void,
): PermissionHandler {
	return {
		start() {
			tracePermission(trace, "tui_native.start");
			// No-op: TUI handles permissions natively
		},
		stop() {
			tracePermission(trace, "tui_native.stop");
			// No-op
		},
	};
}

/**
 * Create a handler that auto-approves file operations within workdir,
 * and deterministically rejects out-of-scope or unknown requests.
 */
function createWorkdirScopedHandler(
	client: OpencodeClient,
	workdir: string,
	trace?: (event: string, data?: unknown) => void,
): PermissionHandler {
	let unsubscribe: (() => void) | undefined;

	return {
		start() {
			tracePermission(trace, "workdir.start", { workdir });
			const abortController = new AbortController();

			(async () => {
				try {
					const { stream } = await client.event.subscribe(undefined, {
						signal: abortController.signal,
					});
					for await (const event of stream) {
						if (abortController.signal.aborted) break;

						const requestId = getPermissionRequestId(event);
						if (isPermissionRequestEvent(event) && requestId) {
							// Access properties dynamically since SDK types may not include all fields
							const props = event.properties as Record<string, unknown>;
							const permission =
								typeof props.permission === "string"
									? props.permission
									: undefined;
							const patterns = getPermissionPatterns(event);
							const tool = props.tool as string | undefined;
							const args = (props.arguments as Record<string, unknown>) ?? {};

							// Extract path from args if possible
							const path = tool ? extractPathFromArgs(tool, args) : undefined;

							const allPatternsInWorkdir =
								patterns.length > 0 &&
								patterns.every((pattern) => isPathInWorkdir(pattern, workdir));

							const shouldApproveScopedPermission =
								isScopedFilePermission(permission) && allPatternsInWorkdir;

							tracePermission(trace, "workdir.request", {
								requestId,
								permission,
								tool,
								path,
								patterns,
							});

							// Auto-approve if path is within workdir
							if (
								(path && isPathInWorkdir(path, workdir)) ||
								shouldApproveScopedPermission
							) {
								try {
									await client.permission.reply({
										requestID: requestId,
										reply: "once",
									});
									tracePermission(trace, "workdir.reply", {
										requestId,
										reply: "once",
										reason: "in_scope",
									});
								} catch {
									// Ignore errors
								}
								continue;
							}

							const rejectMessage = path
								? `Rejected permission outside workdir scope: ${path}`
								: patterns.length > 0
									? `Rejected permission outside workdir scope: ${patterns.join(", ")}`
									: "Rejected permission requiring explicit approval in headless mode";
							try {
								await client.permission.reply({
									requestID: requestId,
									reply: "reject",
									message: `${rejectMessage}. Re-run with TUI enabled or --auto/--ci if appropriate.`,
								});
								tracePermission(trace, "workdir.reply", {
									requestId,
									reply: "reject",
									reason: rejectMessage,
								});
							} catch {
								// Ignore errors
							}
						}
					}
				} catch {
					// Stream errors are expected on abort
				}
			})();

			unsubscribe = () => {
				tracePermission(trace, "workdir.stop");
				abortController.abort();
			};
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a permission handler for the given policy.
 *
 * The handler subscribes to permission request events and responds according
 * to the policy:
 * - "auto-approve-all": Immediately approves all permission requests
 * - "tui-native": No-op (TUI handles permissions natively)
 * - "workdir-scoped": Auto-approves file operations within workdir
 */
export function createPermissionHandler(
	client: OpencodeClient,
	policy: PermissionPolicy,
	trace?: (event: string, data?: unknown) => void,
): PermissionHandler {
	switch (policy.mode) {
		case "auto-approve-all":
			return createAutoApproveHandler(client, trace);
		case "tui-native":
			return createTuiNativeHandler(trace);
		case "workdir-scoped":
			return createWorkdirScopedHandler(client, policy.workdir, trace);
		default:
			// Exhaustive check — should never reach here
			return createTuiNativeHandler();
	}
}
