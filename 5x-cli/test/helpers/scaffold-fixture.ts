/** Build one relocatable CLI scaffold per test file, before tests start. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "./clean-env.js";
import { copyInitializedRepo } from "./git-fixture.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

/** Caller owns cleanup; child exit ensures the copied DB has no live writer. */
export async function createScaffoldedProjectSeed(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "5x-scaffold-seed-"));
	try {
		copyInitializedRepo(dir);
		const proc = Bun.spawn(["bun", "run", BIN, "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
		return dir;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}
