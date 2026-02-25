import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";

/**
 * Generate the 5x.config.js content.
 */
function generateConfigContent(): string {
	return `/** @type {import('5x-cli').FiveXConfig} */
export default {
	// OpenCode server runs locally (same host). Remote server support is a future feature.
	// Configure model/timeouts independently for author and reviewer invocations.
	author: {
		// model: "anthropic/claude-sonnet-4-6",
		// timeout: 900, // seconds; omit to disable timeout
	},
	reviewer: {
		// model: "openai/gpt-5.2",
		// timeout: 900, // seconds; omit to disable timeout
	},

	// Commands run after author implementation and before reviewer pass.
	// Any failing command triggers quality-retry behavior.
	qualityGates: [
		// "bun test",
		// "bun run lint",
		// "bun run build",
	],

	// Optional hook for \`5x run --worktree\` after a new worktree is created.
	worktree: {
		// postCreate: "bun install",
	},

	// Paths are relative to repository root unless absolute.
	paths: {
		plans: "docs/development",
		reviews: "docs/development/reviews",
		archive: "docs/archive",
		templates: {
			plan: "docs/_implementation_plan_template.md",
			review: "docs/development/reviews/_review_template.md",
		},
	},

	// SQLite database location for run history and state.
	db: {
		path: ".5x/5x.db",
	},

	// Loop guardrails and retry limits.
	maxReviewIterations: 5,
	maxQualityRetries: 3,
	maxAutoIterations: 10,
	maxAutoRetries: 3,
};
`;
}

/**
 * Append `.5x/` to .gitignore if not already present.
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignore(projectRoot: string): {
	created: boolean;
	appended: boolean;
} {
	const gitignorePath = join(projectRoot, ".gitignore");
	const entry = ".5x/";

	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
		return { created: true, appended: false };
	}

	const content = readFileSync(gitignorePath, "utf-8");
	const lines = content.split("\n");

	// Check if .5x/ is already in .gitignore (exact line match, trimmed)
	const alreadyPresent = lines.some((line) => line.trim() === entry);
	if (alreadyPresent) {
		return { created: false, appended: false };
	}

	// Append with a newline before if file doesn't end with one
	const separator = content.endsWith("\n") ? "" : "\n";
	writeFileSync(gitignorePath, `${content}${separator}${entry}\n`, "utf-8");
	return { created: false, appended: true };
}

export default defineCommand({
	meta: {
		name: "init",
		description: "Initialize 5x workflow in the current project",
	},
	args: {
		force: {
			type: "boolean",
			description: "Overwrite existing config file",
			default: false,
		},
	},
	async run({ args }) {
		const projectRoot = resolve(".");

		// 1. Generate config file
		const configPath = join(projectRoot, "5x.config.js");
		const configExists = existsSync(configPath);
		if (configExists && !args.force) {
			console.log(
				`  Skipped 5x.config.js (already exists, use --force to overwrite)`,
			);
		} else {
			const configContent = generateConfigContent();
			writeFileSync(configPath, configContent, "utf-8");
			console.log(
				configExists && args.force
					? `  Overwrote 5x.config.js`
					: `  Created 5x.config.js`,
			);
		}

		// 2. Create .5x/ directory
		const dotFiveXDir = join(projectRoot, ".5x");
		if (!existsSync(dotFiveXDir)) {
			mkdirSync(dotFiveXDir, { recursive: true });
			console.log("  Created .5x/ directory");
		} else {
			console.log("  Skipped .5x/ directory (already exists)");
		}

		// 3. Update .gitignore
		const gitignoreResult = ensureGitignore(projectRoot);
		if (gitignoreResult.created) {
			console.log("  Created .gitignore with .5x/");
		} else if (gitignoreResult.appended) {
			console.log("  Added .5x/ to .gitignore");
		} else {
			console.log("  Skipped .gitignore (.5x/ already present)");
		}

		console.log("  TUI mode is enabled by default in interactive terminals");
		console.log("  Use --no-tui on run/plan-review/plan for headless mode");
	},
});

// Export helpers for testing
export { ensureGitignore, generateConfigContent };
