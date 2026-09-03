/**
 * Default RecordCommandContext factory.
 *
 * One `resolveDbContext`, then the run's execution context, then a
 * worktree-re-rooted `RecordStore` plus already-redacted `originFor` /
 * `redactedRecorder`. Handlers never construct `RecordOrigin` by hand and
 * never pass control-plane `config.paths.records` to the working-tree store.
 */

import { homedir } from "node:os";
import {
	createWorkingTreeRecordStore,
	redactOrigin,
	redactRecorder,
} from "../control-plane/index.js";
import type {
	RecordOrigin,
	RecordPerformer,
	RecordRecorder,
} from "../control-plane/record-types.js";
import type { RecordCommandContext } from "../control-plane/record-writer-types.js";
import { getRunV1 } from "../db/operations-v1.js";
import {
	loadOrCreateInstallationIdentity,
	resolveRecorder,
} from "../records/identity.js";
import { resolveRecordsRoot } from "../records/paths.js";
import { type DbContext, resolveDbContext } from "./context.js";
import {
	type RunExecutionContext,
	resolveRunExecutionContext,
} from "./run-context.js";

export class RecordContextError extends Error {
	readonly code: string;
	readonly detail?: unknown;

	constructor(code: string, message: string, detail?: unknown) {
		super(message);
		this.name = "RecordContextError";
		this.code = code;
		this.detail = detail;
	}
}

function copyPerformer(performer: RecordPerformer): RecordPerformer {
	const out: RecordPerformer = { kind: performer.kind };
	if (performer.role !== undefined) out.role = performer.role;
	if (performer.provider !== undefined) out.provider = performer.provider;
	return out;
}

function fallbackExecutionContext(
	runId: string,
	db: DbContext["db"],
	controlPlaneRoot: string,
): RunExecutionContext {
	const run = getRunV1(db, runId);
	if (!run) {
		throw new RecordContextError("RUN_NOT_FOUND", `Run ${runId} not found`);
	}
	return {
		controlPlaneRoot,
		run: {
			id: run.id,
			plan_path: run.plan_path,
			status: run.status,
		},
		mappedWorktreePath: null,
		effectiveWorkingDirectory: controlPlaneRoot,
		effectivePlanPath: run.plan_path,
		planPathInWorktreeExists: true,
	};
}

export async function createRecordContext(opts: {
	runId: string;
	startDir?: string;
	dbContext?: DbContext;
}): Promise<RecordCommandContext> {
	const dbContext =
		opts.dbContext ?? (await resolveDbContext({ startDir: opts.startDir }));
	const { db, config, controlPlane } = dbContext;
	const projectRoot =
		dbContext.projectRoot ?? controlPlane?.controlPlaneRoot ?? process.cwd();
	const controlPlaneRoot = controlPlane?.controlPlaneRoot ?? projectRoot;

	let executionContext: RunExecutionContext;
	const ctxResult = resolveRunExecutionContext(db, opts.runId, {
		controlPlaneRoot,
	});
	if (!ctxResult.ok) {
		if (ctxResult.error.code === "RUN_NOT_FOUND") {
			throw new RecordContextError(
				ctxResult.error.code,
				ctxResult.error.message,
				ctxResult.error.detail,
			);
		}
		// Fail-closed on worktree errors when a control plane exists.
		if (controlPlane && controlPlane.mode !== "none") {
			throw new RecordContextError(
				ctxResult.error.code,
				ctxResult.error.message,
				ctxResult.error.detail,
			);
		}
		executionContext = fallbackExecutionContext(
			opts.runId,
			db,
			controlPlaneRoot,
		);
	} else {
		executionContext = ctxResult.context;
	}

	const resolved = resolveRecordsRoot({
		recordsConfigAbs: config.paths.records,
		controlPlaneRoot,
		effectiveWorkdir: executionContext.effectiveWorkingDirectory,
	});

	const recordStore = createWorkingTreeRecordStore({
		recordsRoot: resolved.recordsAbsPath,
	});

	const identity = loadOrCreateInstallationIdentity({ homeDir: homedir() });
	const redact = config.records.redact;
	const configActor = config.records.actor;

	function rawRecorder(): RecordRecorder {
		return resolveRecorder({
			identity,
			configActor,
			envActor: process.env.FIVEX_RECORDS_ACTOR,
		});
	}

	function redactedRecorder(): RecordRecorder {
		return redactRecorder(rawRecorder(), redact);
	}

	function originFor(performer: RecordPerformer): RecordOrigin {
		const origin = redactOrigin(
			{
				recorder: redactedRecorder(),
				performer: copyPerformer(performer),
			},
			redact,
		);
		if (origin === null) {
			throw new RecordContextError(
				"INVALID_ORIGIN",
				"originFor produced a null origin",
			);
		}
		return origin;
	}

	return {
		db,
		config,
		controlPlane,
		recordStore,
		recordsRelPath: resolved.recordsRelPath,
		recordsAbsPath: resolved.recordsAbsPath,
		executionContext,
		originFor,
		redactedRecorder,
	};
}
