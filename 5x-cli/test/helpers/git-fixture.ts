/**
 * Git fixtures that stay off the concurrent test event loop.
 *
 * `bun test --concurrent` runs every test in a file on one thread.
 * `Bun.spawnSync` blocks that thread, so each extra `git init` / `config` /
 * `add` / `commit` is added to every sibling test's wall clock. Under a full
 * suite those chains cross the 15s timeout even when the assertion itself is
 * fast.
 *
 * Copy a repo that was initialized once, and build multi-commit histories
 * with one async `git fast-import`. Pass `cleanGitEnv()` on every remaining
 * spawn so a leaked `GIT_DIR` cannot retarget the temp repo.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getMaxKnownSchemaVersion,
	runMigrations,
} from "../../src/db/schema.js";
import { cleanGitEnv } from "./clean-env.js";

const SEED_VERSION = "v1";
const FIXTURE_LOCK_POLL_MS = 25;
const FIXTURE_LOCK_POLL_ATTEMPTS = 400;
/**
 * Ownerless locks younger than this can still belong to a build that has not
 * published its pid. A recorded live pid is never stale, however old the lock is.
 */
export const GIT_FIXTURE_LOCK_STALE_AGE_MS = 60_000;

export type ImportedFile = {
	path: string;
	content: string | Uint8Array;
};

export type ImportedCommit = {
	message: string;
	files: readonly ImportedFile[];
};

export type ProjectSeedSpec = {
	files: Record<string, string>;
	message?: string;
	/** Leave an untracked migrated `.5x/5x.db` in the snapshot. */
	migrateDb?: boolean;
};

function canonicalTmp(): string {
	// test/setup.ts points TMPDIR at one physical path before tests run.
	return tmpdir();
}

function gitEnv(): Record<string, string | undefined> {
	return cleanGitEnv();
}

function runGitSync(dir: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: gitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr.toString().trim() ||
				result.stdout.toString().trim() ||
				`git ${args.join(" ")} failed`,
		);
	}
}

async function runGit(dir: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: dir,
		env: gitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`,
		);
	}
}

type FixtureLockOwner = { pid: number; startedAt: string };

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "EPERM"
		) {
			return true;
		}
		return false;
	}
}

function readFixtureLockOwner(lock: string): FixtureLockOwner | null {
	try {
		const parsed = JSON.parse(
			readFileSync(join(lock, "owner.json"), "utf8"),
		) as {
			pid?: unknown;
			startedAt?: unknown;
		};
		if (
			typeof parsed.pid !== "number" ||
			!Number.isInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.startedAt !== "string"
		) {
			return null;
		}
		return { pid: parsed.pid, startedAt: parsed.startedAt };
	} catch {
		return null;
	}
}

/**
 * A live owner's lock is never stale, including when its pid has been reused.
 * A recorded dead pid is stale immediately. An ownerless lock is stale only
 * after the known build window, so a live build's mkdir-to-owner-file gap
 * is not deleted.
 */
export function gitFixtureLockIsStale(lock: string): boolean {
	if (!existsSync(lock)) return false;
	const owner = readFixtureLockOwner(lock);
	if (owner) return !isPidAlive(owner.pid);
	try {
		return Date.now() - statSync(lock).mtimeMs > GIT_FIXTURE_LOCK_STALE_AGE_MS;
	} catch {
		return false;
	}
}

function tryAcquireFixtureLock(lock: string): boolean {
	try {
		mkdirSync(lock);
	} catch {
		return false;
	}
	try {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}),
		);
		return true;
	} catch (error) {
		rmSync(lock, { recursive: true, force: true });
		throw error;
	}
}

function releaseFixtureLock(lock: string): void {
	const owner = readFixtureLockOwner(lock);
	if (owner && owner.pid !== process.pid) return;
	rmSync(lock, { recursive: true, force: true });
}

function reclaimStaleFixtureLock(lock: string): boolean {
	if (!gitFixtureLockIsStale(lock)) return false;
	rmSync(lock, { recursive: true, force: true });
	return tryAcquireFixtureLock(lock);
}

function exclusiveBuild(
	target: string,
	markerRelative: string,
	build: (dir: string) => void,
): string {
	const marker = join(target, markerRelative);
	if (existsSync(marker)) return target;
	const lock = `${target}.lock`;
	let owner = tryAcquireFixtureLock(lock);
	if (!owner && reclaimStaleFixtureLock(lock)) owner = true;
	if (!owner) {
		for (let attempt = 0; attempt < FIXTURE_LOCK_POLL_ATTEMPTS; attempt++) {
			if (existsSync(marker)) return target;
			if (reclaimStaleFixtureLock(lock)) {
				owner = true;
				break;
			}
			Bun.sleepSync(FIXTURE_LOCK_POLL_MS);
		}
	}
	if (!owner) {
		if (existsSync(marker)) return target;
		if (reclaimStaleFixtureLock(lock)) owner = true;
	}
	if (!owner) {
		throw new Error(`timed out waiting for git fixture ${target}`);
	}
	try {
		if (!existsSync(marker)) {
			const buildDir = `${target}.build-${process.pid}-${Date.now()}`;
			rmSync(buildDir, { recursive: true, force: true });
			mkdirSync(buildDir, { recursive: true });
			try {
				build(buildDir);
				rmSync(target, { recursive: true, force: true });
				renameSync(buildDir, target);
			} catch (error) {
				rmSync(buildDir, { recursive: true, force: true });
				throw error;
			}
		}
	} finally {
		if (owner) releaseFixtureLock(lock);
	}
	return target;
}

function identitySeed(): string {
	const target = join(
		canonicalTmp(),
		`5x-cli-git-identity-seed-${SEED_VERSION}`,
	);
	return exclusiveBuild(target, ".git/HEAD", (dir) => {
		runGitSync(dir, ["init", "-b", "main"]);
		runGitSync(dir, ["config", "user.email", "test@test.com"]);
		runGitSync(dir, ["config", "user.name", "Test"]);
	});
}

/** Copy a `git init -b main` repo with the test author configured. */
export function copyInitializedRepo(dest: string): void {
	mkdirSync(dest, { recursive: true });
	cpSync(identitySeed(), dest, { recursive: true });
}

/** Read HEAD without spawning git. Loose refs and packed-refs both count. */
export function readHead(dir: string): string {
	const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
	const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null;
	if (!ref) {
		if (/^[0-9a-f]{40}$/i.test(head)) return head;
		throw new Error(`unreadable HEAD in ${dir}`);
	}
	const loose = join(dir, ".git", ref);
	if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
	const packed = join(dir, ".git", "packed-refs");
	if (existsSync(packed)) {
		for (const line of readFileSync(packed, "utf8").split("\n")) {
			if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
			const [sha, name] = line.split(" ");
			if (name === ref && sha) return sha;
		}
	}
	throw new Error(`missing ref ${ref} in ${dir}`);
}

function commitCommand(message: string): string[] {
	return ["sh", "-c", 'git add -A && git commit -m "$1"', "sh", message];
}

/** Stage everything and commit in one process. Blocks the caller. */
export function commitAllSync(dir: string, message: string): string {
	const result = Bun.spawnSync(commitCommand(message), {
		cwd: dir,
		env: gitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr.toString().trim() ||
				result.stdout.toString().trim() ||
				`git commit failed in ${dir}`,
		);
	}
	return readHead(dir);
}

/** Stage everything and commit in one process without blocking the event loop. */
export async function commitAll(dir: string, message: string): Promise<string> {
	const proc = Bun.spawn(commitCommand(message), {
		cwd: dir,
		env: gitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			stderr.trim() || stdout.trim() || `git commit failed in ${dir}`,
		);
	}
	return readHead(dir);
}

function contentBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string"
		? new TextEncoder().encode(content)
		: content;
}

function quoteGitPath(path: string): string {
	if (path.includes("\n") || path.includes("\0") || path.startsWith(".git")) {
		throw new Error(`unsupported git path ${JSON.stringify(path)}`);
	}
	if (/[^A-Za-z0-9._@/+-]/.test(path)) {
		return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	}
	return path;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function dataCommand(bytes: Uint8Array): Uint8Array[] {
	return [new TextEncoder().encode(`data ${bytes.byteLength}\n`), bytes];
}

function fastImportStream(commits: readonly ImportedCommit[]): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const push = (value: string) => {
		chunks.push(encoder.encode(value));
	};
	commits.forEach((commit, index) => {
		const mark = index + 1;
		const when = 1_700_000_000 + index * 60;
		push(`commit refs/heads/main\nmark :${mark}\n`);
		push(`author Test <test@test.com> ${when} +0000\n`);
		push(`committer Test <test@test.com> ${when} +0000\n`);
		const message = commit.message.endsWith("\n")
			? commit.message
			: `${commit.message}\n`;
		chunks.push(...dataCommand(encoder.encode(message)));
		if (index > 0) push(`from :${mark - 1}\ndeleteall\n`);
		for (const file of commit.files) {
			push(`M 100644 inline ${quoteGitPath(file.path)}\n`);
			chunks.push(...dataCommand(contentBytes(file.content)));
		}
	});
	return concatBytes(chunks);
}

/**
 * Create every commit in one async fast-import, then check the last tree out.
 * Returned hashes are in commit order.
 */
export async function importCommitSequence(
	dir: string,
	commits: readonly ImportedCommit[],
): Promise<string[]> {
	if (commits.length === 0)
		throw new Error("importCommitSequence needs commits");
	copyInitializedRepo(dir);
	const marks = join(dir, ".git", "fi-marks");
	const stream = fastImportStream(commits);
	const bytes = new ArrayBuffer(stream.byteLength);
	new Uint8Array(bytes).set(stream);
	const proc = Bun.spawn(
		["git", "fast-import", "--quiet", `--export-marks=${marks}`],
		{
			cwd: dir,
			env: gitEnv(),
			stdin: new Blob([bytes]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || "git fast-import failed");
	}
	const hashes = new Map<number, string>();
	for (const line of readFileSync(marks, "utf8").split("\n")) {
		const match = /^:(\d+)\s+([0-9a-f]{40})$/i.exec(line.trim());
		if (match?.[1] && match[2]) hashes.set(Number(match[1]), match[2]);
	}
	rmSync(marks, { force: true });
	const ordered: string[] = [];
	for (let index = 0; index < commits.length; index++) {
		const hash = hashes.get(index + 1);
		if (!hash) {
			throw new Error("git fast-import did not export every commit mark");
		}
		ordered.push(hash);
	}
	await runGit(dir, ["reset", "--hard", "HEAD"]);
	return ordered;
}

/** Cache path for a committed project seed. Includes the CLI's DB schema. */
export function projectSeedCachePath(spec: ProjectSeedSpec): string {
	const payload = JSON.stringify({
		version: SEED_VERSION,
		schemaVersion: getMaxKnownSchemaVersion(),
		files: spec.files,
		message: spec.message ?? "init",
		migrateDb: spec.migrateDb ?? false,
	});
	const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
	return join(canonicalTmp(), `5x-cli-git-project-seed-${hash}`);
}

function projectSeed(spec: ProjectSeedSpec): string {
	const target = projectSeedCachePath(spec);
	return exclusiveBuild(target, ".git/refs/heads/main", (dir) => {
		copyInitializedRepo(dir);
		for (const [path, content] of Object.entries(spec.files)) {
			const full = join(dir, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
		if (spec.migrateDb) {
			const state = join(dir, ".5x");
			mkdirSync(state, { recursive: true });
			const db = new Database(join(state, "5x.db"));
			try {
				runMigrations(db);
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				db.close();
			}
		}
		commitAllSync(dir, spec.message ?? "init");
	});
}

/** Copy a committed snapshot. The first caller builds it; the rest copy files. */
export function copyCommittedProject(
	dest: string,
	spec: ProjectSeedSpec,
): void {
	mkdirSync(dest, { recursive: true });
	cpSync(projectSeed(spec), dest, { recursive: true });
}
