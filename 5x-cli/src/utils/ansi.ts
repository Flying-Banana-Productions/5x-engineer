/**
 * ANSI color detection — pure function, no module-level state.
 *
 * Respects NO_COLOR (https://no-color.org/) and FORCE_COLOR conventions.
 * All parameters are injectable for testing without mocking globals.
 */

export interface AnsiConfig {
	dim: string;
	reset: string;
	colorEnabled: boolean;
}

export function resolveAnsi(opts?: {
	isTTY?: boolean;
	env?: Record<string, string | undefined>;
}): AnsiConfig {
	const env = opts?.env ?? process.env;
	const isTTY = opts?.isTTY ?? process.stdout.isTTY === true;

	let enabled: boolean;
	if (env.NO_COLOR !== undefined) {
		enabled = false; // NO_COLOR wins unconditionally
	} else if (env.FORCE_COLOR !== undefined) {
		enabled = env.FORCE_COLOR !== "0"; // FORCE_COLOR=0 disables; any other value enables
	} else {
		enabled = isTTY;
	}

	return {
		dim: enabled ? "\x1b[2m" : "",
		reset: enabled ? "\x1b[0m" : "",
		colorEnabled: enabled,
	};
}
