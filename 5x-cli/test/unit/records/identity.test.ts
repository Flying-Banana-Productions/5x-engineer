import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathUnder } from "../../../src/paths.js";
import {
	IDENTITY_CORRUPT,
	IDENTITY_FILENAME,
	IdentityError,
	identityDir,
	loadOrCreateInstallationIdentity,
	resolveRecorder,
} from "../../../src/records/identity.js";

const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeTmpDir(prefix: string): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function withEnv<T>(
	overrides: Record<string, string | undefined>,
	fn: () => T,
): T {
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(overrides)) {
		previous[key] = process.env[key];
		const next = overrides[key];
		if (next === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = next;
		}
	}
	try {
		return fn();
	} finally {
		for (const key of Object.keys(overrides)) {
			const prev = previous[key];
			if (prev === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = prev;
			}
		}
	}
}

describe("identityDir", () => {
	test("uses FIVEX_CONFIG_HOME without appending 5x", () => {
		const home = makeTmpDir("5x-id-home");
		const configHome = makeTmpDir("5x-id-config-home");
		try {
			withEnv({ FIVEX_CONFIG_HOME: configHome }, () => {
				expect(identityDir(home)).toBe(configHome);
			});
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("falls back to ~/.config/5x on Unix when env is unset", () => {
		if (process.platform === "win32") return;
		const home = makeTmpDir("5x-id-home-fallback");
		try {
			withEnv(
				{ FIVEX_CONFIG_HOME: undefined, XDG_CONFIG_HOME: undefined },
				() => {
					expect(identityDir(home)).toBe(join(home, ".config", "5x"));
				},
			);
		} finally {
			cleanupDir(home);
		}
	});

	test("uses XDG_CONFIG_HOME/5x when set", () => {
		if (process.platform === "win32") return;
		const home = makeTmpDir("5x-id-home-xdg");
		const xdg = makeTmpDir("5x-id-xdg");
		try {
			withEnv({ FIVEX_CONFIG_HOME: undefined, XDG_CONFIG_HOME: xdg }, () => {
				expect(identityDir(home)).toBe(join(xdg, "5x"));
			});
		} finally {
			cleanupDir(home);
			cleanupDir(xdg);
		}
	});
});

describe("loadOrCreateInstallationIdentity", () => {
	test("creates identity.json and reloads the same installation_id", () => {
		const home = makeTmpDir("5x-id-create-home");
		const configHome = makeTmpDir("5x-id-create-config");
		try {
			const first = loadOrCreateInstallationIdentity({
				homeDir: home,
				configHome,
			});
			expect(first.version).toBe(1);
			expect(first.installation_id).toMatch(UUID_V4_RE);
			expect(first.actor).toBeUndefined();

			const filePath = join(configHome, IDENTITY_FILENAME);
			expect(existsSync(filePath)).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(filePath).mode & 0o777).toBe(0o600);
			}

			const second = loadOrCreateInstallationIdentity({
				homeDir: home,
				configHome,
			});
			expect(second.installation_id).toBe(first.installation_id);
			expect(second.version).toBe(1);
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("identity file lives outside a temp repo root", () => {
		const repo = makeTmpDir("5x-id-repo");
		const home = makeTmpDir("5x-id-home-outside");
		const configHome = makeTmpDir("5x-id-config-outside");
		try {
			loadOrCreateInstallationIdentity({ homeDir: home, configHome });
			const filePath = join(configHome, IDENTITY_FILENAME);
			expect(isPathUnder(filePath, repo)).toBe(false);
			expect(isPathUnder(configHome, repo)).toBe(false);
			expect(isPathUnder(filePath, join(repo, ".5x"))).toBe(false);
			expect(
				isPathUnder(filePath, join(repo, "docs", "development", "runs")),
			).toBe(false);
		} finally {
			cleanupDir(repo);
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("corrupt JSON throws IDENTITY_CORRUPT without minting a new id", () => {
		const home = makeTmpDir("5x-id-corrupt-home");
		const configHome = makeTmpDir("5x-id-corrupt-config");
		try {
			const filePath = join(configHome, IDENTITY_FILENAME);
			writeFileSync(filePath, "{not-json", "utf-8");
			expect(() =>
				loadOrCreateInstallationIdentity({ homeDir: home, configHome }),
			).toThrow(IdentityError);
			try {
				loadOrCreateInstallationIdentity({ homeDir: home, configHome });
			} catch (err) {
				expect(err).toBeInstanceOf(IdentityError);
				expect((err as IdentityError).code).toBe(IDENTITY_CORRUPT);
				expect((err as IdentityError).message).toContain(IDENTITY_CORRUPT);
			}
			expect(readFileSync(filePath, "utf-8")).toBe("{not-json");
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("non-UUID installation_id throws IDENTITY_CORRUPT", () => {
		const home = makeTmpDir("5x-id-bad-uuid-home");
		const configHome = makeTmpDir("5x-id-bad-uuid-config");
		try {
			writeFileSync(
				join(configHome, IDENTITY_FILENAME),
				JSON.stringify({ version: 1, installation_id: "not-a-uuid" }),
				"utf-8",
			);
			expect(() =>
				loadOrCreateInstallationIdentity({ homeDir: home, configHome }),
			).toThrow(/IDENTITY_CORRUPT/);
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("UUID v1 installation_id throws IDENTITY_CORRUPT", () => {
		const home = makeTmpDir("5x-id-v1-home");
		const configHome = makeTmpDir("5x-id-v1-config");
		try {
			writeFileSync(
				join(configHome, IDENTITY_FILENAME),
				JSON.stringify({
					version: 1,
					installation_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
				}),
				"utf-8",
			);
			expect(() =>
				loadOrCreateInstallationIdentity({ homeDir: home, configHome }),
			).toThrow(/IDENTITY_CORRUPT/);
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});

	test("unreadable identity file throws IDENTITY_CORRUPT", () => {
		if (process.platform === "win32") return;
		const home = makeTmpDir("5x-id-unreadable-home");
		const configHome = makeTmpDir("5x-id-unreadable-config");
		try {
			const filePath = join(configHome, IDENTITY_FILENAME);
			writeFileSync(
				filePath,
				JSON.stringify({
					version: 1,
					installation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				}),
				"utf-8",
			);
			chmodSync(filePath, 0o000);
			try {
				expect(() =>
					loadOrCreateInstallationIdentity({ homeDir: home, configHome }),
				).toThrow(/IDENTITY_CORRUPT/);
			} finally {
				chmodSync(filePath, 0o600);
			}
		} finally {
			cleanupDir(home);
			cleanupDir(configHome);
		}
	});
});

describe("resolveRecorder", () => {
	const identity = {
		version: 1 as const,
		installation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		actor: "from-identity",
	};

	test("env actor wins over config and identity", () => {
		expect(
			resolveRecorder({
				identity,
				configActor: "from-config",
				envActor: "from-env",
			}),
		).toEqual({
			installation_id: identity.installation_id,
			actor: "from-env",
		});
	});

	test("config actor wins over identity when env is empty", () => {
		expect(
			resolveRecorder({
				identity,
				configActor: "from-config",
				envActor: "  ",
			}),
		).toEqual({
			installation_id: identity.installation_id,
			actor: "from-config",
		});
	});

	test("identity actor is used when env and config are omitted", () => {
		expect(resolveRecorder({ identity })).toEqual({
			installation_id: identity.installation_id,
			actor: "from-identity",
		});
	});

	test("omits actor when none is set", () => {
		expect(
			resolveRecorder({
				identity: {
					version: 1,
					installation_id: identity.installation_id,
				},
			}),
		).toEqual({ installation_id: identity.installation_id });
	});

	test("does not infer actor from OS username or hostname env vars", () => {
		const recorder = withEnv(
			{ USER: "os-user", USERNAME: "os-user", HOSTNAME: "host.example" },
			() =>
				resolveRecorder({
					identity: {
						version: 1,
						installation_id: identity.installation_id,
					},
				}),
		);
		expect(recorder).toEqual({ installation_id: identity.installation_id });
		expect(recorder).not.toHaveProperty("actor");
	});

	test("env and config do not change installation_id", () => {
		const recorder = resolveRecorder({
			identity,
			configActor: "cfg",
			envActor: "env",
		});
		expect(recorder.installation_id).toBe(identity.installation_id);
	});
});
