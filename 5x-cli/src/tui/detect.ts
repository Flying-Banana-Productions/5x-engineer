/** Resolve external TUI-listen mode. */

export interface ResolvedTuiListen {
	enabled: boolean;
	reason: "flag_off" | "quiet" | "non_tty" | "enabled";
}

export function resolveTuiListen(args: {
	"tui-listen"?: boolean;
	quiet?: boolean;
}): ResolvedTuiListen {
	if (args.quiet) {
		return {
			enabled: false,
			reason: "quiet",
		};
	}

	if (!args["tui-listen"]) {
		return {
			enabled: false,
			reason: "flag_off",
		};
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return {
			enabled: false,
			reason: "non_tty",
		};
	}

	return {
		enabled: true,
		reason: "enabled",
	};
}
