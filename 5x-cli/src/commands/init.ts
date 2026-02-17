import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";

/**
 * Detect which agent harnesses are available by checking CLI binaries.
 * Uses spawnSync to avoid nested async subprocess issues.
 */
function detectAdapter(): "claude-code" | "opencode" {
	try {
		const result = Bun.spawnSync(["claude", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return "claude-code";
	} catch {
		// claude not found
	}

	try {
		const result = Bun.spawnSync(["opencode", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return "opencode";
	} catch {
		// opencode not found
	}

	return "claude-code"; // default
}

/**
 * Generate the 5x.config.js content with detected defaults.
 */
function generateConfigContent(adapter: "claude-code" | "opencode"): string {
	return `/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    adapter: '${adapter}',
  },
  reviewer: {
    adapter: '${adapter}',
  },
  qualityGates: [
    // Add your test/lint/build commands here, e.g.:
    // 'bun test',
    // 'bun run lint',
    // 'bun run build',
  ],
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
			const adapter = detectAdapter();
			const configContent = generateConfigContent(adapter);
			writeFileSync(configPath, configContent, "utf-8");
			console.log(
				configExists && args.force
					? `  Overwrote 5x.config.js (detected adapter: ${adapter})`
					: `  Created 5x.config.js (detected adapter: ${adapter})`,
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
	},
});

// Export helpers for testing
export { detectAdapter, ensureGitignore, generateConfigContent };
