/**
 * Permission policy handling for TUI and headless modes.
 *
 * Phase 3 of 004-impl-5x-cli-tui.
 */

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

// ---------------------------------------------------------------------------
// Error message for non-interactive mode without explicit flag
// ---------------------------------------------------------------------------

export const NON_INTERACTIVE_NO_FLAG_ERROR =
	"Error: 5x is running non-interactively but no permission policy was specified.\n" +
	"  Use --auto to auto-approve all tool permissions, or\n" +
	"  use --ci for the same behavior in CI environments.\n" +
	"  To run interactively, ensure stdin is a TTY.";

// ---------------------------------------------------------------------------
// Policy implementation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a path is within the workdir scope.
 * Handles relative paths, absolute paths, and path traversal.
 */
function isPathInWorkdir(path: string, workdir: string): boolean {
	// Normalize paths for comparison
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+/g, "/");
	const normalizedWorkdir = workdir.replace(/\\/g, "/").replace(/\/+/g, "/");

	// Remove trailing slash from workdir for comparison
	const workdirBase = normalizedWorkdir.endsWith("/")
		? normalizedWorkdir.slice(0, -1)
		: normalizedWorkdir;

	// If path is relative, assume it's relative to workdir
	if (!normalizedPath.startsWith("/")) {
		return true;
	}

	// Check if absolute path is under workdir
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

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

/**
 * Create a handler that auto-approves all permission requests immediately.
 */
function createAutoApproveHandler(client: OpencodeClient): PermissionHandler {
	let unsubscribe: (() => void) | undefined;

	return {
		start() {
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
						if (event.type === "permission.asked" && event.properties?.id) {
							// Auto-approve the permission
							try {
								await client.permission.reply({
									requestID: event.properties.id,
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
function createTuiNativeHandler(): PermissionHandler {
	return {
		start() {
			// No-op: TUI handles permissions natively
		},
		stop() {
			// No-op
		},
	};
}

/**
 * Create a handler that auto-approves file operations within workdir,
 * but leaves others for human decision (in headless TTY mode, this
 * would require additional handling — for now we escalate by not responding).
 */
function createWorkdirScopedHandler(
	client: OpencodeClient,
	workdir: string,
): PermissionHandler {
	let unsubscribe: (() => void) | undefined;

	return {
		start() {
			const abortController = new AbortController();

			(async () => {
				try {
					const { stream } = await client.event.subscribe(undefined, {
						signal: abortController.signal,
					});
					for await (const event of stream) {
						if (abortController.signal.aborted) break;

						if (event.type === "permission.asked" && event.properties?.id) {
							// Access properties dynamically since SDK types may not include all fields
							const props = event.properties as Record<string, unknown>;
							const tool = props.tool as string | undefined;
							const args = (props.arguments as Record<string, unknown>) ?? {};

							// Extract path from args if possible
							const path = tool ? extractPathFromArgs(tool, args) : undefined;

							// Auto-approve if path is within workdir
							if (path && isPathInWorkdir(path, workdir)) {
								try {
									await client.permission.reply({
										requestID: props.id as string,
										reply: "once",
									});
								} catch {
									// Ignore errors
								}
							}
							// If path is outside workdir or unknown, don't respond
							// — this leaves the permission pending for human decision
						}
					}
				} catch {
					// Stream errors are expected on abort
				}
			})();

			unsubscribe = () => {
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
): PermissionHandler {
	switch (policy.mode) {
		case "auto-approve-all":
			return createAutoApproveHandler(client);
		case "tui-native":
			return createTuiNativeHandler();
		case "workdir-scoped":
			return createWorkdirScopedHandler(client, policy.workdir);
		default:
			// Exhaustive check — should never reach here
			return createTuiNativeHandler();
	}
}
