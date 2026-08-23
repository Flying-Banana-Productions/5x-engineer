/**
 * Doctor check: control-plane database health.
 *
 * Report-only. Resolves the path from doctor context, opens read-only
 * (no create, no WAL, no migrate), and reports missing / unreadable /
 * schema-behind / schema-ahead / integrity failures. Never migrates,
 * creates files, or opens a writable connection.
 */

import { existsSync } from "node:fs";
import { openDbReadOnly } from "../../db/connection.js";
import { getMaxKnownSchemaVersion, getSchemaVersion } from "../../db/schema.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
} from "../types.js";

export const DB_CHECK_ID = "db";

function asIntegrityRow(row: unknown): string {
	if (!row || typeof row !== "object") return "";
	const value = (row as Record<string, unknown>).integrity_check;
	return typeof value === "string" ? value : String(value ?? "");
}

function finding(
	ctx: DoctorCheckContext,
	partial: Omit<DoctorFinding, "check">,
): DoctorFinding {
	return {
		check: DB_CHECK_ID,
		...partial,
		detail: { dbPath: ctx.dbPath, ...asRecord(partial.detail) },
	};
}

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	if (!existsSync(ctx.dbPath)) {
		return [
			finding(ctx, {
				status: "fail",
				code: "DB_MISSING",
				message: `database file not found at ${ctx.dbPath}`,
				remediation:
					"Initialize with `5x init` or restore a backup. Doctor will not create the database.",
				fixable: false,
			}),
		];
	}

	let db: ReturnType<typeof openDbReadOnly> | undefined;
	try {
		try {
			db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
			// bun:sqlite can "open" a non-database file; the first query fails.
			db.query("SELECT 1").get();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return [
				finding(ctx, {
					status: "fail",
					code: "DB_UNREADABLE",
					message: `cannot read database at ${ctx.dbPath}: ${message}`,
					remediation:
						"Restore from backup or delete the corrupt file. Doctor will not delete it.",
					fixable: false,
					detail: { error: message },
				}),
			];
		}

		const findings: DoctorFinding[] = [];
		const current = getSchemaVersion(db);
		const maxKnown = getMaxKnownSchemaVersion();

		if (current < maxKnown) {
			findings.push(
				finding(ctx, {
					status: "fail",
					code: "DB_SCHEMA_BEHIND",
					message: `database schema is at v${current}, CLI expects v${maxKnown}`,
					remediation: "5x upgrade",
					fixable: false,
					detail: { current, maxKnown },
				}),
			);
		} else if (current > maxKnown) {
			findings.push(
				finding(ctx, {
					status: "fail",
					code: "DB_SCHEMA_AHEAD",
					message:
						`DB schema version v${current} is newer than this CLI's maximum known version v${maxKnown}. ` +
						"Upgrade the CLI or delete .5x/5x.db to reset.",
					remediation:
						"Upgrade the CLI; doctor will not migrate or delete the database.",
					fixable: false,
					detail: { current, maxKnown },
				}),
			);
		}

		try {
			const row = db.query("PRAGMA integrity_check").get();
			const result = asIntegrityRow(row);
			if (result !== "ok") {
				findings.push(
					finding(ctx, {
						status: "fail",
						code: "DB_INTEGRITY",
						message: `PRAGMA integrity_check failed: ${result || "no result"}`,
						remediation:
							"Restore from backup or delete the corrupt file. Doctor will not delete it.",
						fixable: false,
						detail: { integrity: result },
					}),
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			findings.push(
				finding(ctx, {
					status: "fail",
					code: "DB_INTEGRITY",
					message: `PRAGMA integrity_check failed: ${message}`,
					remediation:
						"Restore from backup or delete the corrupt file. Doctor will not delete it.",
					fixable: false,
					detail: { error: message },
				}),
			);
		}

		if (findings.length > 0) return findings;

		return [
			finding(ctx, {
				status: "ok",
				code: "DB_OK",
				message: `schema v${current}, integrity ok`,
				fixable: false,
				detail: { current },
			}),
		];
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [
			finding(ctx, {
				status: "fail",
				code: "DB_UNREADABLE",
				message: `cannot inspect database at ${ctx.dbPath}: ${message}`,
				remediation:
					"Restore from backup or delete the corrupt file. Doctor will not delete it.",
				fixable: false,
				detail: { error: message },
			}),
		];
	} finally {
		try {
			db?.close();
		} catch {
			// already closed
		}
	}
}

export const dbCheck: DoctorCheck = {
	id: DB_CHECK_ID,
	run,
};
