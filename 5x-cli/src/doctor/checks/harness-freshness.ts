/**
 * Doctor check: harness asset freshness (Tier 2).
 *
 * Detect-only `run`. `--fix` calls `harnessSyncCore` without `force` and only
 * for project-scope findings that already satisfy `losslessRefresh`.
 */

import { harnessSyncCore } from "../../commands/harness.handler.js";
import { runHarnessFreshnessChecks } from "../../harnesses/freshness.js";
import type {
	FreshnessReport,
	LosslessBlocker,
} from "../../harnesses/manifest.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";

export const HARNESS_FRESHNESS_CHECK_ID = "harness-freshness";

interface HarnessFindingDetail {
	harness: string;
	scope: string;
	losslessRefresh: boolean;
	losslessBlockers: LosslessBlocker[];
	installedFrom: FreshnessReport["installedFrom"];
}

function findingDetail(finding: DoctorFinding): Partial<HarnessFindingDetail> {
	if (
		!finding.detail ||
		typeof finding.detail !== "object" ||
		Array.isArray(finding.detail)
	) {
		return {};
	}
	return finding.detail as Partial<HarnessFindingDetail>;
}

function harnessRemediation(report: FreshnessReport): string {
	if (report.scope === "user") {
		return `5x harness install ${report.harness} --scope project`;
	}
	if (report.losslessBlockers.includes("assets-modified")) {
		return "5x harness sync --force";
	}
	return "5x harness sync";
}

function freshnessMessage(report: FreshnessReport): string {
	const who = `${report.harness} (${report.scope})`;
	if (report.status === "unknown") {
		return `${who} assets have unknown freshness`;
	}
	return `${who} assets are stale`;
}

function detailFromReport(report: FreshnessReport): HarnessFindingDetail {
	return {
		harness: report.harness,
		scope: report.scope,
		losslessRefresh: report.losslessRefresh,
		losslessBlockers: report.losslessBlockers,
		installedFrom: report.installedFrom,
	};
}

function findingFromReport(report: FreshnessReport): DoctorFinding {
	const projectLossless =
		report.scope === "project" && report.losslessRefresh === true;
	const code =
		report.status === "unknown" ? "HARNESS_UNKNOWN" : "HARNESS_STALE";
	return {
		check: HARNESS_FRESHNESS_CHECK_ID,
		status: report.scope === "user" ? "warn" : "fail",
		code,
		message: freshnessMessage(report),
		remediation: harnessRemediation(report),
		fixable: projectLossless,
		detail: detailFromReport(report),
	};
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	const reports = await runHarnessFreshnessChecks({
		startDir: ctx.startDir,
		homeDir: ctx.homeDir,
		tier2: true,
	});

	const findings: DoctorFinding[] = [];
	for (const report of reports) {
		if (report.status === "not-installed") continue;
		if (report.status === "fresh") continue;
		if (report.status === "stale" || report.status === "unknown") {
			findings.push(findingFromReport(report));
		}
	}

	if (findings.length === 0) {
		return [
			{
				check: HARNESS_FRESHNESS_CHECK_ID,
				status: "ok",
				code: "HARNESS_FRESH",
				message: "installed harness assets are fresh",
				fixable: false,
			},
		];
	}

	return findings;
}

async function fix(
	finding: DoctorFinding,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!finding.fixable) {
		return { attempted: false, message: "finding is not fixable" };
	}

	const detail = findingDetail(finding);
	const harness = String(detail.harness ?? "");
	const scope = String(detail.scope ?? "");
	if (!harness || scope !== "project" || detail.losslessRefresh !== true) {
		return {
			attempted: false,
			message: "harness fix requires project scope and losslessRefresh",
		};
	}

	const output = await harnessSyncCore({
		name: harness,
		scope: "project",
		startDir: ctx.startDir,
		homeDir: ctx.homeDir,
	});
	const match = output.results.find(
		(result) => result.harness === harness && result.scope === "project",
	);
	if (!match || (match.action !== "synced" && match.action !== "adopted")) {
		return {
			attempted: false,
			message: match
				? `harness sync action was ${match.action}`
				: "harness sync produced no matching result",
		};
	}

	return {
		attempted: true,
		message: `synced ${harness} (project)`,
	};
}

export const harnessFreshnessCheck: DoctorCheck = {
	id: HARNESS_FRESHNESS_CHECK_ID,
	run,
	fix,
};
