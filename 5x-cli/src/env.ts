import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, populate } from "dotenv";

export function parseDotenv(content: string): Record<string, string> {
	return parse(content);
}

export function loadEnvFromDirectory(
	directory: string,
	fileNames: string[] = [".env", ".env.local"],
): {
	vars: Record<string, string>;
	loadedFiles: string[];
} {
	const vars: Record<string, string> = {};
	const loadedFiles: string[] = [];

	for (const fileName of fileNames) {
		const filePath = join(directory, fileName);
		if (!existsSync(filePath)) continue;
		const content = readFileSync(filePath, "utf8");
		Object.assign(vars, parseDotenv(content));
		loadedFiles.push(filePath);
	}

	return { vars, loadedFiles };
}

export function applyEnvVars(
	target: Record<string, string | undefined>,
	vars: Record<string, string>,
): void {
	populate(target as Record<string, string>, vars, { override: true });
}

export function overlayEnvFromDirectory(
	directory: string,
	target: Record<string, string | undefined> = process.env,
	fileNames: string[] = [".env", ".env.local"],
): {
	loadedFiles: string[];
	keyCount: number;
} {
	const { vars, loadedFiles } = loadEnvFromDirectory(directory, fileNames);
	const keyCount = Object.keys(vars).length;
	if (keyCount > 0) {
		applyEnvVars(target, vars);
	}
	return { loadedFiles, keyCount };
}
