/**
 * User-scope installation identity for run-record origin.
 *
 * `installation_id` is a random UUID v4 correlator for one CLI install, stored
 * outside the repository (never under `paths.records` or project `.5x/`).
 * Optional `actor` is an operator-chosen label and is never inferred.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RecordRecorder } from "../control-plane/record-types.js";

export const IDENTITY_CORRUPT = "IDENTITY_CORRUPT";
export const IDENTITY_FILENAME = "identity.json";

const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InstallationIdentity {
	version: 1;
	installation_id: string;
	actor?: string;
}

export class IdentityError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "IdentityError";
		this.code = code;
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Directory that holds `identity.json`.
 *
 * Unix: `$XDG_CONFIG_HOME/5x` or `~/.config/5x`.
 * Windows: `%APPDATA%/5x`.
 * If `FIVEX_CONFIG_HOME` is set (tests/CI), use that directory and do not
 * append `"5x"` again.
 */
export function identityDir(homeDir: string): string {
	const configHome = nonEmpty(process.env.FIVEX_CONFIG_HOME);
	if (configHome) return configHome;
	if (process.platform === "win32") {
		const appdata = nonEmpty(process.env.APPDATA);
		if (appdata) return join(appdata, "5x");
		return join(homeDir, "AppData", "Roaming", "5x");
	}
	const xdg = nonEmpty(process.env.XDG_CONFIG_HOME);
	if (xdg) return join(xdg, "5x");
	return join(homeDir, ".config", "5x");
}

function identityCorrupt(path: string, detail: string): IdentityError {
	return new IdentityError(
		IDENTITY_CORRUPT,
		`${IDENTITY_CORRUPT}: installation identity at ${path} is corrupt or unreadable (${detail})`,
	);
}

function parseIdentity(raw: unknown, path: string): InstallationIdentity {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw identityCorrupt(path, "expected a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1) {
		throw identityCorrupt(path, "version must be 1");
	}
	if (
		typeof obj.installation_id !== "string" ||
		!UUID_V4_RE.test(obj.installation_id)
	) {
		throw identityCorrupt(path, "installation_id must be a UUID v4");
	}
	const identity: InstallationIdentity = {
		version: 1,
		installation_id: obj.installation_id,
	};
	if (obj.actor !== undefined) {
		if (typeof obj.actor !== "string" || obj.actor.trim().length === 0) {
			throw identityCorrupt(path, "actor must be a non-empty string when set");
		}
		identity.actor = obj.actor;
	}
	return identity;
}

function isErrno(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === code
	);
}

function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch (err) {
		if (!isErrno(err, "ENOENT")) throw err;
	}
}

function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function chmodPrivate(path: string): void {
	try {
		chmodSync(path, 0o600);
	} catch {
		// POSIX modes are not supported on every platform.
	}
}

function readExistingIdentity(filePath: string): InstallationIdentity {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(filePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw identityCorrupt(filePath, message);
	}
	if (!st.isFile()) {
		throw identityCorrupt(filePath, "not a regular file");
	}
	let text: string;
	try {
		text = readFileSync(filePath, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw identityCorrupt(filePath, message);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw identityCorrupt(filePath, message);
	}
	return parseIdentity(parsed, filePath);
}

/**
 * Publish `identity.json` with an exclusive hard link so the first writer
 * wins. Returns true when this process created the file; false when another
 * writer already published. Never replaces an existing identity.
 */
function publishIdentityExclusive(
	filePath: string,
	identity: InstallationIdentity,
): boolean {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const tmpPath = join(
		dir,
		`${IDENTITY_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
	);
	const body = `${JSON.stringify(identity, null, 2)}\n`;
	writeFileSync(tmpPath, body, { encoding: "utf-8", mode: 0o600 });
	chmodPrivate(tmpPath);
	try {
		fsyncPath(tmpPath);
	} catch {
		// fsync is best-effort; exclusive link is the race primitive.
	}
	try {
		linkSync(tmpPath, filePath);
	} catch (err) {
		unlinkQuiet(tmpPath);
		if (isErrno(err, "EEXIST")) return false;
		throw err;
	}
	try {
		fsyncPath(dir);
	} catch {
		// Directory fsync is best-effort on platforms that reject it.
	}
	unlinkQuiet(tmpPath);
	chmodPrivate(filePath);
	try {
		fsyncPath(dir);
	} catch {
		// Directory fsync is best-effort on platforms that reject it.
	}
	return true;
}

export function loadOrCreateInstallationIdentity(opts: {
	homeDir: string;
	configHome?: string;
}): InstallationIdentity {
	const dir = opts.configHome ?? identityDir(opts.homeDir);
	const filePath = join(dir, IDENTITY_FILENAME);

	if (existsSync(filePath)) {
		return readExistingIdentity(filePath);
	}

	const created: InstallationIdentity = {
		version: 1,
		installation_id: randomUUID(),
	};
	if (publishIdentityExclusive(filePath, created)) {
		return created;
	}
	return readExistingIdentity(filePath);
}

/**
 * Actor precedence (first non-empty wins): env `FIVEX_RECORDS_ACTOR` →
 * `config.records.actor` → `identity.actor`. Never infers OS username,
 * hostname, or Git identity.
 */
export function resolveRecorder(opts: {
	identity: InstallationIdentity;
	configActor?: string;
	envActor?: string;
}): RecordRecorder {
	const actor =
		nonEmpty(opts.envActor) ??
		nonEmpty(opts.configActor) ??
		nonEmpty(opts.identity.actor);
	if (actor) {
		return {
			installation_id: opts.identity.installation_id,
			actor,
		};
	}
	return { installation_id: opts.identity.installation_id };
}
