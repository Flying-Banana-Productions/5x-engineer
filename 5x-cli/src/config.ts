import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const AgentConfigSchema = z.object({
	model: z.string().optional(),
});

const PathsSchema = z.object({
	plans: z.string().default("docs/development"),
	reviews: z.string().default("docs/development/reviews"),
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

const FiveXConfigSchema = z.object({
	author: AgentConfigSchema.default({}),
	reviewer: AgentConfigSchema.default({}),
	qualityGates: z.array(z.string()).default([]),
	paths: PathsSchema.default({}),
	db: DbSchema.default({}),
	maxReviewIterations: z.number().int().positive().default(5),
	maxQualityRetries: z.number().int().positive().default(3),
	maxAutoIterations: z.number().int().positive().default(10),
	maxAutoRetries: z.number().int().positive().default(3),
});

export type FiveXConfig = z.infer<typeof FiveXConfigSchema>;

/**
 * Helper for config files to get autocomplete.
 * Usage in 5x.config.js:
 *   import { defineConfig } from '5x-cli';
 *   export default defineConfig({ ... });
 *
 * Or with JSDoc:
 *   /** @type {import('5x-cli').FiveXConfig} *\/
 *   export default { ... };
 */
export function defineConfig(
	config: Partial<FiveXConfig>,
): Partial<FiveXConfig> {
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

function warnUnknownConfigKeys(rawConfig: unknown, configPath: string): void {
	if (!isRecord(rawConfig)) return;

	const allowedRoot = new Set([
		"author",
		"reviewer",
		"qualityGates",
		"paths",
		"db",
		"maxReviewIterations",
		"maxQualityRetries",
		"maxAutoIterations",
		"maxAutoRetries",
	]);
	const allowedAgent = new Set(["model"]);
	const allowedPaths = new Set(["plans", "reviews", "archive", "templates"]);
	const allowedTemplates = new Set(["plan", "review"]);
	const allowedDb = new Set(["path"]);

	const deprecatedHelp = new Map<string, string>([
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
				unknown.push(prefix ? `${prefix}.${key}` : key);
				continue;
			}

			const value = obj[key];
			if (!isRecord(value)) continue;

			const nextPrefix = prefix ? `${prefix}.${key}` : key;
			if (key === "author" || key === "reviewer") {
				collect(value, allowedAgent, nextPrefix);
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

	for (const path of unknown) {
		const help = deprecatedHelp.get(path);
		console.error(
			help
				? `Warning: Deprecated config key "${path}" in ${configPath} (ignored). ${help}`
				: `Warning: Unknown config key "${path}" in ${configPath} (ignored).`,
		);
	}
}

/**
 * Load and validate 5x.config.js / .mjs from the project root.
 * Falls back to defaults if no config file is found.
 * Throws with an actionable error if the file exists but fails to load.
 */
export async function loadConfig(
	projectRoot: string,
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

	warnUnknownConfigKeys(rawConfig, configPath);

	const result = FiveXConfigSchema.safeParse(rawConfig);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid config in ${configPath}:\n${issues}`);
	}

	return {
		config: result.data,
		configPath,
	};
}

// Re-export for shared use
export { discoverConfigFile, FiveXConfigSchema };
