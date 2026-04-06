import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { z } from "zod";

const AgentConfigSchema = z.object({
	/** Provider name — open string to allow third-party plugins (e.g. "opencode", "codex", "@acme/provider-foo"). */
	provider: z.string().default("opencode"),
	model: z.string().optional(),
	/**
	 * Optional per-harness model id overrides for `5x harness install`.
	 * Keys are harness plugin names (e.g. `opencode`, `cursor`). When set for the
	 * harness being installed, values replace `[author|reviewer].model` in generated
	 * agent frontmatter for that harness only.
	 */
	harnessModels: z.record(z.string(), z.string()).optional(),
	/** Optional per-invocation timeout in seconds. Omit to disable timeouts. */
	timeout: z.number().int().positive().optional(),
	/** When true, enforce session continuity across steps within the same phase.
	 *  Requires --session <id> or --new-session when prior steps exist for the
	 *  same run/step/phase. Default false — enable after confirming all relevant
	 *  templates have -continued variants. */
	continuePhaseSessions: z.boolean().default(false),
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
		skipQualityGates: z.boolean().default(false),
		worktree: WorktreeSchema.default({}),
		paths: PathsSchema.default({}),
		db: DbSchema.default({}),
		maxStepsPerRun: z.number().int().positive().default(250),
		// Preserved for backward compat, deprecated
		maxReviewIterations: z.number().int().positive().default(5),
		maxQualityRetries: z.number().int().positive().default(3),
		maxAutoIterations: z.number().int().positive().default(10),
		maxAutoRetries: z.number().int().positive().default(3),
	})
	.passthrough(); // Allow plugin-specific config keys (e.g. codex: { ... })

export type FiveXConfig = z.infer<typeof FiveXConfigSchema>;

/** Role key for {@link resolveHarnessModelForRole}. */
export type AgentConfigRole = "author" | "reviewer";

/**
 * Resolve which model string to inject for a harness install.
 *
 * Uses `[role].harnessModels[<harnessName>]` when non-empty after trim; otherwise
 * falls back to `[role].model`. Returns `undefined` when neither yields a value.
 */
export function resolveHarnessModelForRole(
	config: FiveXConfig,
	role: AgentConfigRole,
	harnessName: string,
): string | undefined {
	const agent = config[role];
	const key = harnessName.trim();
	const override =
		key.length > 0 ? agent.harnessModels?.[key]?.trim() : undefined;
	if (override) return override;
	const fallback = agent.model?.trim();
	return fallback || undefined;
}

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
		// Validate URL — the schema validates file-based config via z.string().url(),
		// but CLI overrides bypass schema parsing. Apply the same check here.
		try {
			new URL(opencodeUrl);
		} catch {
			throw new Error(
				`Invalid --opencode-url: "${opencodeUrl}" is not a valid URL`,
			);
		}
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

/** Ordered by priority — TOML is preferred over JS. */
const CONFIG_FILENAMES = ["5x.toml", "5x.config.js", "5x.config.mjs"] as const;

/** TOML-only overlay; merged after main config(s). Never used for primary discovery. */
const LOCAL_CONFIG_FILENAME = "5x.toml.local";

/**
 * Walk up from `startDir` to find a config file.
 * Returns the absolute path to the config file, or null.
 *
 * @param stopDir - If provided, stop walking at this directory (inclusive).
 *   Prevents discovery from escaping beyond a boundary (e.g. controlPlaneRoot).
 */
function discoverConfigFile(startDir: string, stopDir?: string): string | null {
	let dir = resolve(startDir);
	const root = resolve("/");
	const boundary = stopDir ? resolve(stopDir) : null;

	while (true) {
		for (const filename of CONFIG_FILENAMES) {
			const candidate = join(dir, filename);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		// Stop at boundary (inclusive — we already checked this dir)
		if (boundary && dir === boundary) break;
		const parent = dirname(dir);
		if (parent === dir || dir === root) break;
		dir = parent;
	}

	return null;
}

/**
 * Detect whether a directory is a git worktree checkout root.
 *
 * Git worktrees have a `.git` **file** (not directory) that points to the
 * main repo's `.git/worktrees/<name>` directory.  A normal repo has a
 * `.git` **directory**.  This distinction lets us tell the two apart
 * without parsing the file contents.
 */
export function isWorktreeRoot(dir: string): boolean {
	const dotGit = join(dir, ".git");
	try {
		return statSync(dotGit).isFile();
	} catch {
		return false;
	}
}

export interface LoadConfigResult {
	config: FiveXConfig;
	configPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Resolve relative path strings in `raw.paths` against `baseDir`.
 *
 * Walks `raw.paths` and resolves each relative string value against `baseDir`
 * using `resolve(baseDir, value)`. Handles nested `paths.templates.plan` and
 * `paths.templates.review`. Already-absolute paths pass through unchanged.
 * Non-path fields are untouched.
 *
 * Returns a shallow clone with only `paths` modified.
 */
function resolveRawConfigPaths(raw: unknown, baseDir: string): unknown {
	if (!isRecord(raw)) return raw;

	const paths = raw.paths;
	if (!isRecord(paths)) return raw;

	const resolvedPaths: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(paths)) {
		if (key === "templates" && isRecord(value)) {
			// Handle nested templates object
			const resolvedTemplates: Record<string, unknown> = {};
			for (const [tKey, tValue] of Object.entries(value)) {
				if (typeof tValue === "string") {
					resolvedTemplates[tKey] = resolve(baseDir, tValue);
				} else {
					resolvedTemplates[tKey] = tValue;
				}
			}
			resolvedPaths[key] = resolvedTemplates;
		} else if (typeof value === "string") {
			resolvedPaths[key] = resolve(baseDir, value);
		} else {
			resolvedPaths[key] = value;
		}
	}

	return { ...raw, paths: resolvedPaths };
}

/**
 * Resolve all `paths.*` values in a parsed FiveXConfig to absolute paths.
 *
 * Used after Zod parsing to ensure that default values (e.g., `"docs/development"`)
 * are resolved against the given `baseDir` (typically workspace root or projectRoot).
 * Already-absolute paths pass through unchanged.
 */
function resolveConfigPaths(config: FiveXConfig, baseDir: string): FiveXConfig {
	return {
		...config,
		paths: {
			plans: resolve(baseDir, config.paths.plans),
			reviews: resolve(baseDir, config.paths.reviews),
			...(config.paths.planReviews
				? { planReviews: resolve(baseDir, config.paths.planReviews) }
				: {}),
			...(config.paths.runReviews
				? { runReviews: resolve(baseDir, config.paths.runReviews) }
				: {}),
			archive: resolve(baseDir, config.paths.archive),
			templates: {
				plan: resolve(baseDir, config.paths.templates.plan),
				review: resolve(baseDir, config.paths.templates.review),
			},
		},
	};
}

function warnUnknownConfigKeys(
	rawConfig: unknown,
	configPath: string,
	cliProviderNames?: Set<string>,
	warn: (...args: unknown[]) => void = console.error,
): void {
	if (!isRecord(rawConfig)) return;

	const allowedRoot = new Set([
		"author",
		"reviewer",
		"opencode",
		"qualityGates",
		"skipQualityGates",
		"worktree",
		"paths",
		"db",
		"maxStepsPerRun",
		"maxReviewIterations",
		"maxQualityRetries",
		"maxAutoIterations",
		"maxAutoRetries",
	]);
	const allowedAgent = new Set([
		"provider",
		"model",
		"harnessModels",
		"timeout",
		"continuePhaseSessions",
	]);
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
			'Renamed to "maxStepsPerRun". Run "5x upgrade" to update your config.',
		],
	]);

	// Deprecated keys that are unknown (not in schema) — treated as unknown with help text.
	const deprecatedUnknown = new Map<string, string>([
		["author.adapter", "No longer used — you can safely remove it."],
		["reviewer.adapter", "No longer used — you can safely remove it."],
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
			} else if (
				key === "harnessModels" &&
				(prefix === "author" || prefix === "reviewer")
			) {
				for (const hk of Object.keys(value).sort()) {
					const hv = value[hk];
					if (typeof hv !== "string") {
						unknown.push(`${nextPrefix}.${hk}`);
					}
				}
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
			warn(`Note: "${key}" is deprecated. ${help}`);
		}
	}

	// Warn about unknown/deprecated-unknown keys
	for (const path of unknown) {
		const help = deprecatedUnknown.get(path);
		warn(
			help
				? `Note: "${path}" is deprecated. ${help}`
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
 * Deep merge two plain objects. `override` fields take precedence.
 *
 * Merge semantics:
 * - **Objects:** deep field-level merge. Nested fields from `base` are
 *   preserved when not present in `override`.
 * - **Arrays:** replace. Override array replaces base array entirely.
 * - **Primitives:** override wins.
 */
function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };

	for (const key of Object.keys(override)) {
		const baseVal = base[key];
		const overVal = override[key];

		if (Array.isArray(overVal)) {
			// Arrays: replace entirely
			result[key] = overVal;
		} else if (isRecord(overVal) && isRecord(baseVal)) {
			// Objects: deep merge
			result[key] = deepMerge(baseVal, overVal);
		} else {
			// Primitives, null, undefined: override wins
			result[key] = overVal;
		}
	}

	return result;
}

/**
 * Load and parse `5x.toml.local` for merging. Returns null if the file is absent.
 */
function prepareLocalTomlOverlay(
	localPath: string,
	options: {
		stripDb: boolean;
		warn: (...args: unknown[]) => void;
		cliProviderNames?: Set<string>;
	},
): Record<string, unknown> | null {
	if (!existsSync(localPath)) return null;

	let raw: unknown;
	try {
		const text = readFileSync(localPath, "utf-8");
		raw = parseToml(text);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to load ${localPath}: ${message}. Config must be a valid TOML file.`,
		);
	}

	if (!isRecord(raw)) {
		throw new Error(
			`Invalid config in ${localPath}: expected a TOML table at the root.`,
		);
	}

	warnUnknownConfigKeys(raw, localPath, options.cliProviderNames, options.warn);

	const resolvedPaths = resolveRawConfigPaths(raw, dirname(localPath));
	const prepared: Record<string, unknown> = isRecord(resolvedPaths)
		? resolvedPaths
		: raw;

	if (options.stripDb && "db" in prepared) {
		options.warn(
			`Warning: "db" section in ${localPath} is ignored. ` +
				"DB path is always resolved from the root config.",
		);
		const { db: _db, ...rest } = prepared;
		return rest;
	}

	return prepared;
}

/**
 * Merge `5x.toml.local` overlays after root + nearest main configs.
 * Order: merged main ← root local ← nearest local (nearest skipped if same path as root local).
 */
function mergeLayeredLocalTomlIntoRaw(
	mergedRaw: unknown,
	controlPlaneRoot: string,
	nearestConfigPath: string | null,
	warn: (...args: unknown[]) => void,
	cliProviderNames?: Set<string>,
): unknown {
	const base = isRecord(mergedRaw) ? mergedRaw : {};
	let out = base;

	const rootLocalPath = join(resolve(controlPlaneRoot), LOCAL_CONFIG_FILENAME);
	const rootOverlay = prepareLocalTomlOverlay(rootLocalPath, {
		stripDb: false,
		warn,
		cliProviderNames,
	});
	if (rootOverlay) {
		out = deepMerge(out, rootOverlay);
	}

	if (nearestConfigPath) {
		const nearestLocalPath = join(
			dirname(nearestConfigPath),
			LOCAL_CONFIG_FILENAME,
		);
		if (resolve(nearestLocalPath) !== resolve(rootLocalPath)) {
			const nearestOverlay = prepareLocalTomlOverlay(nearestLocalPath, {
				stripDb: true,
				warn,
				cliProviderNames,
			});
			if (nearestOverlay) {
				out = deepMerge(out, nearestOverlay);
			}
		}
	}

	return out;
}

/**
 * Load and validate 5x.config.js / .mjs from the project root.
 * Falls back to defaults if no config file is found.
 * Throws with an actionable error if the file exists but fails to load.
 *
 * @param cliProviderNames — provider names from CLI flags (e.g. --author-provider).
 *   These are authoritative: matching top-level config keys are treated as plugin
 *   config and suppressed from unknown-key warnings.
 * @param warn — optional warning output function (default: console.error).
 *   Inject a custom function in tests to avoid monkey-patching the global.
 */
export async function loadConfig(
	projectRoot: string,
	cliProviderNames?: Set<string>,
	warn?: (...args: unknown[]) => void,
): Promise<LoadConfigResult> {
	const warnFn = warn ?? console.error;
	const configPath = discoverConfigFile(projectRoot);
	const resolvedRoot = resolve(projectRoot);

	let rawConfig: unknown;

	if (!configPath) {
		const localPath = join(resolvedRoot, LOCAL_CONFIG_FILENAME);
		const localOverlay = prepareLocalTomlOverlay(localPath, {
			stripDb: false,
			warn: warnFn,
			cliProviderNames,
		});
		if (!localOverlay) {
			const config = resolveConfigPaths(
				FiveXConfigSchema.parse({}),
				projectRoot,
			);
			return {
				config,
				configPath: null,
			};
		}
		rawConfig = deepMerge({}, localOverlay);
	} else {
		try {
			if (configPath.endsWith(".toml")) {
				const text = readFileSync(configPath, "utf-8");
				rawConfig = parseToml(text);
			} else {
				const module = await import(configPath);
				rawConfig = module.default ?? module;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const hint = configPath.endsWith(".toml")
				? "Config must be a valid TOML file."
				: "Config must be a JS/MJS module exporting a default config object.";
			throw new Error(`Failed to load ${configPath}: ${message}. ${hint}`);
		}

		warnUnknownConfigKeys(rawConfig, configPath, cliProviderNames, warnFn);

		// Resolve raw paths against the config file's directory before Zod parsing
		rawConfig = resolveRawConfigPaths(rawConfig, dirname(configPath));

		const localPath = join(dirname(configPath), LOCAL_CONFIG_FILENAME);
		const localOverlay = prepareLocalTomlOverlay(localPath, {
			stripDb: false,
			warn: warnFn,
			cliProviderNames,
		});
		if (localOverlay) {
			rawConfig = deepMerge(isRecord(rawConfig) ? rawConfig : {}, localOverlay);
		}
	}

	const sourceLabel = configPath ?? join(resolvedRoot, LOCAL_CONFIG_FILENAME);

	const result = FiveXConfigSchema.safeParse(rawConfig);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid config in ${sourceLabel}:\n${issues}`);
	}

	// P0.1: Honor maxAutoIterations as alias for maxStepsPerRun when the
	// user hasn't explicitly set maxStepsPerRun. This prevents existing configs
	// from silently increasing run length/cost.
	let config = applyDeprecatedAliases(result.data, rawConfig);

	// Resolve any remaining Zod default paths against projectRoot.
	// Explicit config values are already absolute (resolved against dirname(configPath) above).
	// paths.* contract: all values are absolute after config loading.
	config = resolveConfigPaths(config, projectRoot);

	return {
		config,
		configPath,
	};
}

// ---------------------------------------------------------------------------
// Config layering (Phase 1c)
// ---------------------------------------------------------------------------

export interface LayeredConfigResult {
	config: FiveXConfig;
	rootConfigPath: string | null;
	nearestConfigPath: string | null;
	isLayered: boolean;
}

/**
 * Load raw config from a config file path.
 * Returns the raw parsed object, or null if the file doesn't exist.
 */
async function loadRawConfig(configPath: string): Promise<unknown> {
	if (configPath.endsWith(".toml")) {
		const text = readFileSync(configPath, "utf-8");
		return parseToml(text);
	}
	const module = await import(configPath);
	return module.default ?? module;
}

/**
 * Resolve a layered config from root and nearest config files.
 *
 * Config resolution is anchored to the **plan's location** in the project
 * structure, not to cwd. This eliminates ambient context drift while
 * allowing sub-project-specific overrides.
 *
 * Merge semantics: Zod defaults ← root config ← nearest config overrides
 * ← `5x.toml.local` at control-plane root ← `5x.toml.local` beside nearest
 * config (when different path).
 * - Objects: deep field-level merge.
 * - Arrays: replace (nearest array replaces root array entirely).
 * - `db` section: always from root config (or Zod defaults). Nearest
 *   config `db` is ignored with a warning. Nearest `5x.toml.local` `db`
 *   is also ignored; root `5x.toml.local` may override `db`.
 *
 * @param controlPlaneRoot - Root of the control-plane (where root config lives).
 * @param contextDir - Optional directory for nearest config discovery.
 *   If omitted or same as controlPlaneRoot, only root config is used.
 * @param warn - Warning output function (for `db` override warnings).
 */
export async function resolveLayeredConfig(
	controlPlaneRoot: string,
	contextDir?: string,
	warn: (...args: unknown[]) => void = console.error,
): Promise<LayeredConfigResult> {
	// Discover root config — only look at controlPlaneRoot itself (no upward walk)
	const rootConfigPath = discoverConfigFile(controlPlaneRoot, controlPlaneRoot);
	let rootRaw: unknown = null;

	if (rootConfigPath) {
		try {
			rootRaw = await loadRawConfig(rootConfigPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const hint = rootConfigPath.endsWith(".toml")
				? "Config must be a valid TOML file."
				: "Config must be a JS/MJS module exporting a default config object.";
			throw new Error(`Failed to load ${rootConfigPath}: ${message}. ${hint}`);
		}
		// Resolve raw paths against the root config file's directory
		rootRaw = resolveRawConfigPaths(rootRaw, dirname(rootConfigPath));
	}

	// Discover nearest config (only if contextDir is different from root)
	let nearestConfigPath: string | null = null;
	let nearestRaw: unknown = null;

	if (contextDir) {
		const resolvedContext = resolve(contextDir);
		const resolvedRoot = resolve(controlPlaneRoot);

		if (resolvedContext !== resolvedRoot) {
			// Bound discovery to controlPlaneRoot to prevent escaping the repo tree
			nearestConfigPath = discoverConfigFile(resolvedContext, controlPlaneRoot);

			// Only use nearest if it's a different file from root
			if (
				nearestConfigPath &&
				rootConfigPath &&
				resolve(nearestConfigPath) === resolve(rootConfigPath)
			) {
				nearestConfigPath = null;
			}

			// Skip nearest config at a worktree root — it's a copy of the
			// repo root config (same git content, different filesystem path),
			// not a sub-project override.  Without this, worktree checkouts
			// trigger false layering, spurious db-section warnings, and
			// incorrect path resolution against the worktree directory.
			if (nearestConfigPath && isWorktreeRoot(dirname(nearestConfigPath))) {
				nearestConfigPath = null;
			}

			if (nearestConfigPath) {
				try {
					nearestRaw = await loadRawConfig(nearestConfigPath);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const hint = nearestConfigPath.endsWith(".toml")
						? "Config must be a valid TOML file."
						: "Config must be a JS/MJS module exporting a default config object.";
					throw new Error(
						`Failed to load ${nearestConfigPath}: ${message}. ${hint}`,
					);
				}
				// Resolve raw paths against the nearest config file's directory
				nearestRaw = resolveRawConfigPaths(
					nearestRaw,
					dirname(nearestConfigPath),
				);
			}
		}
	}

	// Merge: Zod defaults ← root ← nearest
	let mergedRaw: unknown;
	const isLayered = nearestRaw !== null;

	if (rootRaw && nearestRaw && isRecord(rootRaw) && isRecord(nearestRaw)) {
		// Check for db override in nearest config — emit warning and strip
		if ("db" in nearestRaw) {
			warn(
				`Warning: "db" section in ${nearestConfigPath} is ignored. ` +
					"DB path is always resolved from the root config.",
			);
			const { db: _db, ...nearestWithoutDb } = nearestRaw;
			mergedRaw = deepMerge(rootRaw, nearestWithoutDb);
		} else {
			mergedRaw = deepMerge(rootRaw, nearestRaw);
		}
	} else if (rootRaw) {
		mergedRaw = rootRaw;
	} else if (nearestRaw) {
		// No root config, sub-project config only
		if (isRecord(nearestRaw) && "db" in nearestRaw) {
			warn(
				`Warning: "db" section in ${nearestConfigPath} is ignored. ` +
					"DB path is always resolved from the root config.",
			);
			const { db: _db, ...nearestWithoutDb } = nearestRaw;
			mergedRaw = nearestWithoutDb;
		} else {
			mergedRaw = nearestRaw;
		}
	} else {
		mergedRaw = {};
	}

	mergedRaw = mergeLayeredLocalTomlIntoRaw(
		mergedRaw,
		controlPlaneRoot,
		nearestConfigPath,
		warn,
	);

	// Parse through Zod to fill defaults
	const result = FiveXConfigSchema.safeParse(mergedRaw);
	if (!result.success) {
		const source = isLayered
			? `merged config from ${rootConfigPath ?? "defaults"} + ${nearestConfigPath}`
			: (rootConfigPath ?? nearestConfigPath ?? "config");
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid config in ${source}:\n${issues}`);
	}

	let config = applyDeprecatedAliases(result.data, mergedRaw);

	// Resolve any remaining Zod default paths against the workspace root.
	// Explicit config values are already absolute (resolved against their
	// config file's directory above). paths.* contract: all values are absolute.
	config = resolveConfigPaths(config, resolve(controlPlaneRoot));

	return {
		config,
		rootConfigPath,
		nearestConfigPath,
		isLayered,
	};
}

// Re-export for shared use
export { discoverConfigFile, FiveXConfigSchema };
