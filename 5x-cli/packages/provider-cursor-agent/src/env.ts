import type { CursorAgentConfig } from "./types.js";

/**
 * Build subprocess environment for Cursor Agent.
 *
 * Preserves ambient `process.env` and injects configured secrets via env vars
 * (never argv). Does not mutate `process.env`.
 */
export function buildSubprocessEnv(
	config: Pick<CursorAgentConfig, "apiKey" | "authToken"> = {},
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };

	if (config.apiKey !== undefined && config.apiKey !== "") {
		env.CURSOR_API_KEY = config.apiKey;
	}

	if (config.authToken !== undefined && config.authToken !== "") {
		env.CURSOR_AUTH_TOKEN = config.authToken;
	}

	return env;
}
