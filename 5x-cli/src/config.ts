import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const AgentConfigSchema = z.object({
	/** Provider name — open string to allow third-party plugins (e.g. "opencode", "codex", "@acme/provider-foo"). */
	provider: z.string().default("opencode"),
	model: z.string().optional(),
	/** Optional per-invocation timeout in seconds. Omit to disable timeouts. */
	timeout: z.number().int().positive().optional(),
});

const PathsSchema = z.object({
	plans: z.string().default("docs/development"),
	reviews: z.string().default("docs/development/reviews"),
	/** Directory for plan reviews. Defaults to `reviews` at runtime. */
	planReviews: z.string().optional(),
	/** Directory for implementation (run) reviews. Defaults to `reviews` at runtime. */
	runReviews: z.string().optional(),
	archive: z.string().default("docs/archive"),
	templates: z
		.object({
			plan: z.string().default("docs/_implementation_plan_template.md"),
			review: z
				.string()
				.default("docs/development/reviews/_review_template.md"),
		})
		.default({}),
});

const DbSchema = z.object({
	path: z.string().default(".5x/5x.db"),
});

const WorktreeSchema = z.object({
	/** Optional shell command to run after creating a new worktree. */
	postCreate: z.string().min(1).optional(),
});

const OpenCodeConfigSchema = z.object({
	/** URL for external OpenCode server. Omit for managed (local) mode. */
	url: z.string().url().optional(),
});

const FiveXConfigSchema = z
	.object({
		author: AgentConfigSchema.default({}),
		reviewer: AgentConfigSchema.default({}),
		opencode: OpenCodeConfigSchema.default({}),
		qualityGates: z.array(z.string()).default([]),
		worktree: WorktreeSchema.default({}),
		paths: PathsSchema.default({}),
		db: DbSchema.default({}),
		maxStepsPerRun: z.number().int().positive().default(50),
		// Preserved for backward compat, deprecated
		maxReviewIterations: z.number().int().positive().default(5),
		maxQualityRetries: z.number().int().positive().default(3),
		maxAutoIterations: z.number().int().positive().default(10),
		maxAutoRetries: z.number().int().positive().default(3),
	})
	.passthrough(); // Allow plugin-specific config keys (e.g. codex: { ... })

export type FiveXConfig = z.infer<typeof FiveXConfigSchema>;

export interface ModelOverrides {
	authorModel?: string;
	reviewerModel?: string;
	authorProvider?: string;
	reviewerProvider?: string;
	opencodeUrl?: string;
}

/**
 * Apply CLI overrides on top of loaded config.
 * CLI flags take precedence over config file values when provided.
 * Supports model, provider, and opencode URL overrides.
 */
export function applyModelOverrides(
	config: FiveXConfig,
	overrides: ModelOverrides,
): FiveXConfig {
	const authorModel = overrides.authorModel?.trim();
	const reviewerModel = overrides.reviewerModel?.trim();
	const authorProvider = overrides.authorProvider?.trim();
	const reviewerProvider = overrides.reviewerProvider?.trim();
	const opencodeUrl = overrides.opencodeUrl?.trim();

	let author = config.author;
	if (authorModel || authorProvider) {
		author = {
			...author,
			...(authorModel ? { model: authorModel } : {}),
			...(authorProvider ? { provider: authorProvider } : {}),
		};
	}

	let reviewer = config.reviewer;
	if (reviewerModel || reviewerProvider) {
		reviewer = {
			...reviewer,
			...(reviewerModel ? { model: reviewerModel } : {}),
			...(reviewerProvider ? { provider: reviewerProvider } : {}),
		};
	}

	let opencode = config.opencode;
	if (opencodeUrl) {
		opencode = { ...opencode, url: opencodeUrl };
	}

	return {
		...config,
		author,
		reviewer,
		opencode,
	};
}

/** Input type for config files — all keys optional, Zod fills in defaults. */
export type FiveXConfigInput = z.input<typeof FiveXConfigSchema>;

/**
 * Helper for config files to get autocomplete.
 * Usage in 5x.config.js:
 *   import { defineConfig } from '5x-cli';
 *   export default defineConfig({ ... });
 *
 * Or with JSDoc:
 *   /** @type {import('5x-cli').FiveXConfigInput} *\/
 *   export default { ... };
 */
export function defineConfig(config: FiveXConfigInput): FiveXConfigInput {
	return config;
}

const CONFIG_FILENAMES = ["5x.config.js", "5x.config.mjs"] as const;

/**
 * Walk up from `startDir` to find a config file.
 * Returns the absolute path to the config file, or null.
 */
function discoverConfigFile(startDir: string): string | null {
	let dir = resolve(startDir);
	const root = resolve("/");

	while (true) {
		for (const filename of CONFIG_FILENAMES) {
			const candidate = join(dir, filename);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		const parent = dirname(dir);
		if (parent === dir || dir === root) break;
		dir = parent;
	}

	return null;
}

export interface LoadConfigResult {
	config: FiveXConfig;
	configPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

function warnUnknownConfigKeys(
	rawConfig: unknown,
	configPath: string,
	cliProviderNames?: Set<string>,
): void {
	if (!isRecord(rawConfig)) return;

	const allowedRoot = new Set([
		"author",
		"reviewer",
		"opencode",
		"qualityGates",
		"worktree",
		"paths",
		"db",
		"maxStepsPerRun",
		"maxReviewIterations",
		"maxQualityRetries",
		"maxAutoIterations",
		"maxAutoRetries",
	]);
	const allowedAgent = new Set(["provider", "model", "timeout"]);
	const allowedOpencode = new Set(["url"]);
	const allowedWorktree = new Set(["postCreate"]);
	const allowedPaths = new Set([
		"plans",
		"reviews",
		"planReviews",
		"runReviews",
		"archive",
		"templates",
	]);
	const allowedTemplates = new Set(["plan", "review"]);
	const allowedDb = new Set(["path"]);

	// Collect provider names referenced in author/reviewer config AND from CLI
	// overrides. Top-level keys matching these names are plugin config — not unknown.
	// CLI overrides are authoritative: suppress warnings for their provider keys.
	const providerNames = new Set<string>(cliProviderNames);
	for (const role of ["author", "reviewer"]) {
		const roleConfig = rawConfig[role];
		if (
			isRecord(roleConfig) &&
			typeof roleConfig.provider === "string" &&
			roleConfig.provider !== "opencode"
		) {
			providerNames.add(roleConfig.provider);
		}
	}

	// Deprecated keys that are still parsed but should produce a warning.
	// These are in the allowed set (not unknown), but we emit deprecation notices.
	const deprecatedAllowed = new Map<string, string>([
		[
			"maxAutoIterations",
			"Use maxStepsPerRun instead. maxAutoIterations is deprecated.",
		],
	]);

	// Deprecated keys that are unknown (not in schema) — treated as unknown with help text.
	const deprecatedUnknown = new Map<string, string>([
		["author.adapter", "Use author.model instead."],
		["reviewer.adapter", "Use reviewer.model instead."],
	]);

	const unknown: string[] = [];

	function collect(
		obj: Record<string, unknown>,
		allowed: Set<string>,
		prefix: string,
	): void {
		for (const key of Object.keys(obj).sort()) {
			if (!allowed.has(key)) {
				// Suppress warnings for top-level keys matching a configured provider name
				if (!prefix && providerNames.has(key)) {
					continue;
				}
				unknown.push(prefix ? `${prefix}.${key}` : key);
				continue;
			}

			const value = obj[key];
			if (!isRecord(value)) continue;

			const nextPrefix = prefix ? `${prefix}.${key}` : key;
			if (key === "author" || key === "reviewer") {
				collect(value, allowedAgent, nextPrefix);
			} else if (key === "opencode") {
				collect(value, allowedOpencode, nextPrefix);
			} else if (key === "worktree") {
				collect(value, allowedWorktree, nextPrefix);
			} else if (key === "paths") {
				collect(value, allowedPaths, nextPrefix);
				const templates = value.templates;
				if (isRecord(templates)) {
					collect(templates, allowedTemplates, `${nextPrefix}.templates`);
				}
			} else if (key === "db") {
				collect(value, allowedDb, nextPrefix);
			}
		}
	}

	collect(rawConfig, allowedRoot, "");

	// Warn about deprecated-but-still-parsed keys that are present in the config
	for (const [key, help] of deprecatedAllowed) {
		if (key in rawConfig) {
			console.error(
				`Warning: Deprecated config key "${key}" in ${configPath}. ${help}`,
			);
		}
	}

	// Warn about unknown/deprecated-unknown keys
	for (const path of unknown) {
		const help = deprecatedUnknown.get(path);
		console.error(
			help
				? `Warning: Deprecated config key "${path}" in ${configPath} (ignored). ${help}`
				: `Warning: Unknown config key "${path}" in ${configPath} (ignored).`,
		);
	}
}

/**
 * Apply deprecated config aliases after parsing.
 *
 * If `maxAutoIterations` was explicitly set in the raw config but
 * `maxStepsPerRun` was NOT, treat `maxAutoIterations` as the effective
 * `maxStepsPerRun`. This ensures existing configs that set
 * `maxAutoIterations` for safety/cost limits are honored (while the
 * deprecation warning is still emitted by `warnUnknownConfigKeys`).
 */
function applyDeprecatedAliases(
	config: FiveXConfig,
	rawConfig: unknown,
): FiveXConfig {
	if (!isRecord(rawConfig)) return config;

	// Only alias if the user explicitly set maxAutoIterations but did NOT
	// explicitly set maxStepsPerRun (i.e. maxStepsPerRun is the Zod default).
	if ("maxAutoIterations" in rawConfig && !("maxStepsPerRun" in rawConfig)) {
		const legacy = rawConfig.maxAutoIterations;
		if (typeof legacy === "number" && Number.isInteger(legacy) && legacy > 0) {
			return { ...config, maxStepsPerRun: legacy };
		}
	}

	return config;
}

/**
 * Load and validate 5x.config.js / .mjs from the project root.
 * Falls back to defaults if no config file is found.
 * Throws with an actionable error if the file exists but fails to load.
 *
 * @param cliProviderNames — provider names from CLI flags (e.g. --author-provider).
 *   These are authoritative: matching top-level config keys are treated as plugin
 *   config and suppressed from unknown-key warnings.
 */
export async function loadConfig(
	projectRoot: string,
	cliProviderNames?: Set<string>,
): Promise<LoadConfigResult> {
	const configPath = discoverConfigFile(projectRoot);

	if (!configPath) {
		return {
			config: FiveXConfigSchema.parse({}),
			configPath: null,
		};
	}

	let rawConfig: unknown;
	try {
		const module = await import(configPath);
		rawConfig = module.default ?? module;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to load ${configPath}: ${message}. ` +
				`Config must be a JS/MJS module exporting a default config object.`,
		);
	}

	warnUnknownConfigKeys(rawConfig, configPath, cliProviderNames);

	const result = FiveXConfigSchema.safeParse(rawConfig);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid config in ${configPath}:\n${issues}`);
	}

	// P0.1: Honor maxAutoIterations as alias for maxStepsPerRun when the
	// user hasn't explicitly set maxStepsPerRun. This prevents existing configs
	// from silently increasing run length/cost.
	const config = applyDeprecatedAliases(result.data, rawConfig);

	return {
		config,
		configPath,
	};
}

// Re-export for shared use
export { discoverConfigFile, FiveXConfigSchema };
