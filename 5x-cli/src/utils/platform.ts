import { homedir } from "node:os";

const isWin = process.platform === "win32";

/** Shell command vector for spawning user-authored shell commands. */
export function shellArgs(command: string): string[] {
	return isWin ? ["cmd", "/c", command] : ["sh", "-c", command];
}

/** Cross-platform home directory — single source of truth. */
export function userHomeDir(): string {
	return homedir();
}
