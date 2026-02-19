/**
 * TUI mode detection — determines whether to spawn the TUI.
 *
 * Phase 2 of 004-impl-5x-cli-tui.
 */

/**
 * Determine whether TUI mode should be enabled.
 *
 * TUI requires both stdin and stdout to be TTYs (interactive terminal),
 * and must not be disabled by --no-tui or --quiet flags.
 *
 * **Non-auto gate (until Phase 5):** TUI mode is only enabled in --auto
 * flows. Non-auto flows rely on readline-based human gates that are
 * incompatible with a terminal-owning child process. Once Phase 5 (TUI
 * gates) lands, this restriction will be lifted.
 *
 * @param args - Command arguments (must include noTui, quiet, and auto flags)
 * @returns true if TUI mode should be active
 */
export function shouldEnableTui(args: {
	"no-tui"?: boolean;
	quiet?: boolean;
	auto?: boolean;
}): boolean {
	// --quiet implies --no-tui (strong user intent to suppress all output)
	if (args.quiet) return false;

	// Explicit opt-out
	if (args["no-tui"]) return false;

	// Non-auto flows use readline gates which conflict with TUI owning stdin.
	// Gate TUI on --auto until Phase 5 (TUI gates) is implemented.
	if (!args.auto) return false;

	// Both stdin and stdout must be TTYs — TUI needs interactive I/O
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

	return true;
}
