/**
 * Environment scrubbing for the `claude` subprocess.
 *
 * Claude Code's auth precedence places `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` above subscription/OAuth, silently. If either is
 * present in our parent env (e.g. another project exports it for its own
 * API client), the spawned `claude` will burn API credits instead of the
 * user's Claude subscription. We strip both so subscription/OAuth wins.
 *
 * Users who actually want API-key auth opt in explicitly via
 * `[claude-code].apiKey` in 5x.toml.
 */

const AUTH_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function buildSubprocessEnv(
	apiKey?: string,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of AUTH_ENV_VARS) {
		delete env[key];
	}
	if (apiKey !== undefined && apiKey !== "") {
		env.ANTHROPIC_API_KEY = apiKey;
	}
	return env;
}
