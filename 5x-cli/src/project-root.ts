import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverConfigFile } from "./config.js";

/**
 * Walk up from `startDir` looking for a `.git` directory.
 * Returns the directory containing `.git`, or null.
 */
export function findGitRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	const root = resolve("/");
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === root) break;
		dir = parent;
	}
	return null;
}

/**
 * Resolve the project root directory using a consistent strategy:
 *
 * 1. If a config file is discovered (walking up from startDir), use its parent dir.
 * 2. Else if a `.git` directory is found (walking up), use that directory.
 * 3. Else fall back to `resolve(startDir)`.
 *
 * This ensures DB paths, artifact roots, and git safety checks all anchor
 * to the same directory regardless of which subdirectory the CLI is invoked from.
 */
export function resolveProjectRoot(startDir?: string): string {
	const start = resolve(startDir ?? ".");

	// Prefer config file location — most explicit signal of project root
	const configPath = discoverConfigFile(start);
	if (configPath) return dirname(configPath);

	// Fall back to git root
	const gitRoot = findGitRoot(start);
	if (gitRoot) return gitRoot;

	// Last resort: the starting directory itself
	return start;
}
