import { Command } from "@commander-js/extra-typings";
import { version } from "./version.js";

export function createProgram(): Command {
	const program = new Command("5x")
		.version(version, "-V, --version")
		.description(
			"A toolbelt of primitives for the 5x workflow.\n\n" +
				"The 5x CLI manages implementation runs, invokes AI agents, validates\n" +
				"structured output, and orchestrates the plan-author-review development\n" +
				"cycle. Most commands output JSON envelopes to stdout for machine\n" +
				"consumption. Use --pretty for human-readable formatting.",
		)
		.exitOverride()
		.showHelpAfterError("(use --help for additional information)")
		.showSuggestionAfterError(true)
		.addHelpText(
			"afterAll",
			"\nMost commands output JSON envelopes ({ ok, data } or { ok, error }) to stdout.\n" +
				"Exceptions: init, upgrade, and harness install emit human-readable text;\n" +
				"run watch streams NDJSON or human-readable output.\n" +
				"Use --pretty for formatted JSON output, --no-pretty for compact.\n" +
				"Exit codes: 0=success, 1=error, 2=not found, 3=non-interactive,\n" +
				"4=locked, 5=dirty, 6=limit, 7=invalid output.\n\n" +
				"Documentation: https://github.com/5x-ai/5x-cli\n" +
				"Configuration: 5x.toml in project root",
		);

	// Note: --pretty / --no-pretty are NOT registered as commander options.
	// They are handled by pre-parse argv stripping in bin.ts (see design
	// decision above). This ensures they work at any argv position and
	// apply even on parse-error JSON envelopes.

	return program;
}
