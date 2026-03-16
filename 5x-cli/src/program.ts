import { Command } from "@commander-js/extra-typings";
import { version } from "./version.js";

export function createProgram(): Command {
	const program = new Command("5x")
		.version(version, "-V, --version")
		.description(
			"A toolbelt of primitives for the 5x workflow.\n\n" +
				"The 5x CLI manages implementation runs, invokes AI agents, validates\n" +
				"structured output, and orchestrates the plan-author-review development\n" +
				"cycle. Output defaults to JSON envelopes; use --text for human-readable\n" +
				"output.",
		)
		.exitOverride()
		.showHelpAfterError("(use --help for additional information)")
		.showSuggestionAfterError(true)
		.addHelpText(
			"afterAll",
			"\nOutput format:\n" +
				"  --text              Human-readable text output\n" +
				"  --json              JSON envelopes (default)\n" +
				"  --pretty/--no-pretty  Format JSON output (no effect in text mode)\n" +
				"  FIVEX_OUTPUT_FORMAT=text|json  Set default via environment variable\n" +
				"  Precedence: --text/--json flag > FIVEX_OUTPUT_FORMAT env > json (default)\n\n" +
				"JSON envelopes use { ok, data } for success, { ok, error } for errors.\n" +
				"Grandfathered: init, upgrade, and harness install always emit text;\n" +
				"run watch streams NDJSON or human-readable output.\n\n" +
				"Exit codes: 0=success, 1=error, 2=not found, 3=non-interactive,\n" +
				"4=locked, 5=dirty, 6=limit, 7=invalid output.\n\n" +
				"Documentation: https://github.com/5x-ai/5x-cli\n" +
				"Configuration: 5x.toml in project root",
		);

	// Note: --pretty / --no-pretty and --text / --json are NOT registered as
	// commander options. They are handled by pre-parse argv stripping in
	// bin.ts. This ensures they work at any argv position and apply even on
	// parse-error JSON envelopes.

	return program;
}
