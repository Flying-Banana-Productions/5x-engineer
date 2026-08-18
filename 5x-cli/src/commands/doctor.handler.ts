/**
 * Doctor command handler — detect → optional fix → re-detect.
 *
 * Framework-independent: no CLI framework imports.
 * Accepts optional `startDir` / `checks` for unit tests.
 */

import { join, resolve } from "node:path";
import {
	builtinDoctorChecks,
	checkFailedFinding,
	doctorExitCode,
	findingKey,
	summarizeDoctor,
} from "../doctor/registry.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorReport,
} from "../doctor/types.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { resolveProjectContext } from "./context.js";
import {
	DB_FILENAME,
	normalizeDbPath,
	resolveControlPlaneRoot,
} from "./control-plane.js";

export interface DoctorRunParams {
	fix?: boolean;
	startDir?: string;
	homeDir?: string;
	now?: number;
	/** Override built-in checks — used by unit tests with stub checks. */
	checks?: DoctorCheck[];
}

async function resolveDoctorContext(
	params: DoctorRunParams,
): Promise<DoctorCheckContext> {
	try {
		const startDir = resolve(params.startDir ?? ".");
		const controlPlane = resolveControlPlaneRoot(startDir);
		const stateDir = controlPlane.stateDir;

		let projectRoot: string;
		let dbRelPath: string;

		if (controlPlane.mode !== "none") {
			projectRoot = controlPlane.controlPlaneRoot;
			dbRelPath = join(stateDir, DB_FILENAME);
		} else {
			const ctx = await resolveProjectContext({ startDir });
			projectRoot = ctx.projectRoot;
			dbRelPath = join(normalizeDbPath(ctx.config.db.path), DB_FILENAME);
		}

		const dbPath = resolve(projectRoot, dbRelPath);
		return {
			startDir,
			projectRoot,
			stateDir,
			homeDir: params.homeDir,
			dbPath,
			dbRelPath,
			now: params.now,
		};
	} catch (err) {
		if (err instanceof CliError) throw err;
		const message = err instanceof Error ? err.message : String(err);
		outputError("DOCTOR_CONTEXT", `Cannot resolve doctor context: ${message}`);
	}
}

/**
 * Human-first doctor report. Column-aligns check id / status; prints
 * remediation under the finding; appends a `Fixed:` section when repairs
 * were claimed.
 */
export function formatDoctorText(report: DoctorReport): void {
	if (report.checks.length === 0 && report.fixed.length === 0) {
		console.log("(none)");
		return;
	}

	if (report.checks.length > 0) {
		const maxCheck = Math.max(...report.checks.map((f) => f.check.length));
		const maxStatus = Math.max(4, ...report.checks.map((f) => f.status.length));
		for (const f of report.checks) {
			console.log(
				`${f.check.padEnd(maxCheck)}  ${f.status.padEnd(maxStatus)}  ${f.message}`,
			);
			if (f.remediation) {
				console.log(`  → ${f.remediation}`);
			}
		}
	}

	if (report.fixed.length > 0) {
		if (report.checks.length > 0) console.log("");
		console.log("Fixed:");
		const maxCheck = Math.max(...report.fixed.map((f) => f.check.length));
		const maxCode = Math.max(...report.fixed.map((f) => f.code.length));
		for (const item of report.fixed) {
			console.log(
				`  ${item.check.padEnd(maxCheck)}  ${item.code.padEnd(maxCode)}  ${item.message}`,
			);
		}
	}
}

export async function doctorRun(params: DoctorRunParams = {}): Promise<void> {
	const ctx = await resolveDoctorContext(params);
	const checks = params.checks ?? builtinDoctorChecks;
	const fixed: DoctorReport["fixed"] = [];
	const findings: DoctorFinding[] = [];

	for (const check of checks) {
		let detected: DoctorFinding[];
		try {
			detected = await check.run(ctx);
		} catch (err) {
			findings.push(checkFailedFinding(check.id, err));
			continue;
		}

		if (!params.fix || !check.fix) {
			findings.push(...detected);
			continue;
		}

		let current = detected;
		for (const candidate of detected.filter((f) => f.fixable)) {
			try {
				findingKey(candidate); // throws if fixable + empty identity
			} catch (err) {
				findings.push(checkFailedFinding(check.id, err));
				break; // no write attempted; keep `current` (unfixed findings still reported)
			}
			let result: Awaited<ReturnType<NonNullable<DoctorCheck["fix"]>>>;
			try {
				result = await check.fix(candidate, ctx);
			} catch (err) {
				findings.push(checkFailedFinding(check.id, err));
				break; // keep `current` (unfixed findings still reported); sibling checks still run
			}
			if (!result.attempted) continue;
			let again: DoctorFinding[];
			try {
				again = await check.run(ctx);
			} catch (err) {
				findings.push(checkFailedFinding(check.id, err));
				current = [];
				break;
			}
			let stillThere: boolean;
			try {
				stillThere = again.some(
					(f) => f.status === "fail" && findingKey(f) === findingKey(candidate),
				);
			} catch (err) {
				findings.push(checkFailedFinding(check.id, err));
				current = [];
				break;
			}
			if (!stillThere) {
				fixed.push({
					check: check.id,
					code: candidate.code,
					message: result.message,
				});
			}
			current = again;
		}
		findings.push(...current);
	}

	const report = summarizeDoctor(findings, fixed);
	outputSuccess(report, formatDoctorText);
	process.exitCode = doctorExitCode(report);
}
