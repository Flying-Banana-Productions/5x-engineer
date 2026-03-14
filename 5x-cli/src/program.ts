import { Command } from "@commander-js/extra-typings";
import { version } from "./version.js";

export function createProgram(): Command {
	const program = new Command("5x")
		.version(version, "-V, --version")
		.description("A toolbelt of primitives for the 5x workflow")
		.exitOverride()
		.showHelpAfterError("(use --help for additional information)")
		.showSuggestionAfterError(true);

	// Note: --pretty / --no-pretty are NOT registered as commander options.
	// They are handled by pre-parse argv stripping in bin.ts (see design
	// decision above). This ensures they work at any argv position and
	// apply even on parse-error JSON envelopes.

	return program;
}
