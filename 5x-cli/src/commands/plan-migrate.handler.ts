/**
 * Pre-approval schema 1 conversion. Writes no governance record.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createWorkingTreeRecordStore } from "../control-plane/record-fs.js";
import { createReviewBudgetStore } from "../control-plane/review-budget-store.js";
import { CliError } from "../output.js";
import { loadPlanDocument } from "../plan-schema/document.js";
import { resolveRecordsRoot } from "../records/paths.js";
import { planFileGovernedReason } from "../review-governance/implementation-state.js";
import {
	equivalentWrapInterior,
	nonGoverningLines,
	wrapEquivalentPlan,
} from "../review-governance/schema-migration.js";
import { resolveDbContext } from "./context.js";

export interface PlanMigrateInput {
	planPath: string;
	mode: string;
	write?: boolean;
	dryRun?: boolean;
	startDir?: string;
}

export async function planMigrate(input: PlanMigrateInput): Promise<{
	wrote: boolean;
	unchanged: boolean;
	mode: "equivalent" | "selective";
	schema: 1;
	path: string;
	message: string;
	nonGoverningText?: { line: number; text: string }[];
}> {
	if (input.mode !== "equivalent" && input.mode !== "selective") {
		throw new CliError(
			"INVALID_ARGS",
			"--mode must be equivalent or selective.",
		);
	}
	const startDir = resolve(input.startDir ?? ".");
	const absolute = isAbsolute(input.planPath)
		? input.planPath
		: resolve(startDir, input.planPath);
	if (!existsSync(absolute)) {
		throw new CliError("PLAN_NOT_FOUND", `Plan file not found: ${absolute}`);
	}
	const dbContext = await resolveDbContext({ startDir });
	const projectRoot =
		dbContext.projectRoot ??
		dbContext.controlPlane?.controlPlaneRoot ??
		startDir;
	const controlPlaneRoot =
		dbContext.controlPlane?.controlPlaneRoot ?? projectRoot;
	const records = resolveRecordsRoot({
		recordsConfigAbs: dbContext.config.paths.records,
		controlPlaneRoot,
		effectiveWorkdir: controlPlaneRoot,
	});
	const recordStore = createWorkingTreeRecordStore({
		recordsRoot: records.recordsAbsPath,
		controlPlaneRoot,
	});
	const store = createReviewBudgetStore(recordStore);
	const governed = planFileGovernedReason({
		recordStore,
		store,
		planPath: absolute,
	});
	if (governed) {
		throw new CliError("PLAN_MIGRATION_CONFLICT", governed);
	}
	const raw = readFileSync(absolute, "utf8");
	const write = Boolean(input.write) && !input.dryRun;
	if (input.mode === "selective") {
		const loaded = loadPlanDocument(raw, 1);
		if (!loaded.ok) {
			throw new CliError(
				loaded.code,
				`${loaded.message} Selective mode checks a schema 1 file the operator already edited.`,
			);
		}
		const nonGoverningText = nonGoverningLines(
			raw,
			new Set(
				loaded.document.governingLineLocations.map((line) => line.lineNumber),
			),
		);
		return {
			wrote: false,
			unchanged: true,
			mode: "selective",
			schema: 1,
			path: absolute,
			nonGoverningText,
			message:
				"Submit the file through ordinary plan review. This command did not approve the plan or write a governance record.",
		};
	}
	const interior = equivalentWrapInterior(raw);
	const next = interior === null ? wrapEquivalentPlan(raw) : raw;
	if (interior === null) {
		const loaded = loadPlanDocument(raw, "file");
		if (loaded.ok && loaded.document.schema === 1) {
			throw new CliError(
				"PLAN_MIGRATION_NOT_EQUIVALENT",
				"Equivalent mode wraps an unversioned plan. This file is already schema 1 and is not the mechanical contract wrap. Use --mode selective.",
			);
		}
		const wrapped = loadPlanDocument(next, 1);
		if (!wrapped.ok) {
			throw new CliError(wrapped.code, wrapped.message);
		}
	}
	const unchanged = next === raw;
	if (write && !unchanged) writeFileSync(absolute, next);
	return {
		wrote: write && !unchanged,
		unchanged,
		mode: "equivalent",
		schema: 1,
		path: absolute,
		message:
			"Submit the file through ordinary plan review. This command did not approve the plan or write a governance record.",
	};
}
