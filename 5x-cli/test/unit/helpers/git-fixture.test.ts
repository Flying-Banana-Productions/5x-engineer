import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getMaxKnownSchemaVersion,
	getSchemaVersion,
} from "../../../src/db/schema.js";
import {
	copyCommittedProject,
	GIT_FIXTURE_LOCK_STALE_AGE_MS,
	gitFixtureLockIsStale,
	projectSeedCachePath,
	readHead,
} from "../../helpers/git-fixture.js";

const DEAD_PID = 99999999;

function tempDir(name: string): string {
	return join(
		tmpdir(),
		`5x-cli-git-fixture-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`,
	);
}

function plantLock(lock: string, pid: number | null, old: boolean): void {
	rmSync(lock, { recursive: true, force: true });
	mkdirSync(lock);
	if (pid !== null) {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({
				pid,
				startedAt: "2020-01-01T00:00:00.000Z",
			}),
		);
	}
	if (old) {
		const when = new Date(Date.now() - GIT_FIXTURE_LOCK_STALE_AGE_MS - 5_000);
		utimesSync(lock, when, when);
	}
}

describe("git fixture seed cache", () => {
	test("project seed cache key includes the DB schema version", () => {
		const spec = {
			files: { "a.txt": "alpha" },
			message: "schema-key",
			migrateDb: true,
		};
		const included = createHash("sha256")
			.update(
				JSON.stringify({
					version: "v1",
					schemaVersion: getMaxKnownSchemaVersion(),
					files: spec.files,
					message: spec.message,
					migrateDb: true,
				}),
			)
			.digest("hex")
			.slice(0, 16);
		const omitted = createHash("sha256")
			.update(
				JSON.stringify({
					version: "v1",
					files: spec.files,
					message: spec.message,
					migrateDb: true,
				}),
			)
			.digest("hex")
			.slice(0, 16);
		expect(projectSeedCachePath(spec)).toBe(
			join(tmpdir(), `5x-cli-git-project-seed-${included}`),
		);
		expect(projectSeedCachePath(spec)).not.toBe(
			join(tmpdir(), `5x-cli-git-project-seed-${omitted}`),
		);
	});

	test("a migrated seed matches this CLI's schema version", () => {
		const dest = tempDir("schema");
		try {
			copyCommittedProject(dest, {
				files: { "README.md": "schema" },
				message: "schema-seed",
				migrateDb: true,
			});
			const db = new Database(join(dest, ".5x", "5x.db"));
			try {
				expect(getSchemaVersion(db)).toBe(getMaxKnownSchemaVersion());
			} finally {
				db.close();
			}
		} finally {
			rmSync(dest, { recursive: true, force: true });
		}
	});

	test("a live owner lock is not stale even when it is old", () => {
		const lock = tempDir("live-lock");
		plantLock(lock, process.pid, true);
		try {
			expect(gitFixtureLockIsStale(lock)).toBe(false);
			expect(existsSync(join(lock, "owner.json"))).toBe(true);
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	});

	test("an ownerless lock is stale only after the build window", () => {
		const lock = tempDir("empty-lock");
		plantLock(lock, null, false);
		try {
			expect(gitFixtureLockIsStale(lock)).toBe(false);
			const when = new Date(Date.now() - GIT_FIXTURE_LOCK_STALE_AGE_MS - 5_000);
			utimesSync(lock, when, when);
			expect(gitFixtureLockIsStale(lock)).toBe(true);
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	});

	test("an interrupted cache with a dead owner is rebuilt", () => {
		const spec = {
			files: {
				"interrupted.txt": `cache-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			},
			message: "interrupted cache",
		};
		const seed = projectSeedCachePath(spec);
		const lock = `${seed}.lock`;
		rmSync(seed, { recursive: true, force: true });
		plantLock(lock, DEAD_PID, false);
		const dest = tempDir("interrupted");
		try {
			const started = Date.now();
			copyCommittedProject(dest, spec);
			expect(Date.now() - started).toBeLessThan(9_000);
			expect(readHead(dest)).toMatch(/^[0-9a-f]{40}$/i);
			expect(existsSync(join(dest, "interrupted.txt"))).toBe(true);
			expect(existsSync(lock)).toBe(false);
			const again = tempDir("interrupted-again");
			try {
				copyCommittedProject(again, spec);
				expect(readHead(again)).toBe(readHead(dest));
			} finally {
				rmSync(again, { recursive: true, force: true });
			}
		} finally {
			rmSync(dest, { recursive: true, force: true });
		}
	});

	test("an old ownerless lock is reclaimed", () => {
		const spec = {
			files: {
				"ownerless.txt": `ownerless-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			},
			message: "ownerless cache",
		};
		const seed = projectSeedCachePath(spec);
		const lock = `${seed}.lock`;
		rmSync(seed, { recursive: true, force: true });
		plantLock(lock, null, true);
		const dest = tempDir("ownerless");
		try {
			const started = Date.now();
			copyCommittedProject(dest, spec);
			expect(Date.now() - started).toBeLessThan(9_000);
			expect(readHead(dest)).toMatch(/^[0-9a-f]{40}$/i);
			expect(existsSync(lock)).toBe(false);
		} finally {
			rmSync(dest, { recursive: true, force: true });
		}
	});
});
