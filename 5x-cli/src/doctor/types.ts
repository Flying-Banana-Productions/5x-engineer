/**
 * Doctor check registry types.
 *
 * Checks detect only; optional `fix` performs one deterministic repair.
 * Plugin contribution is deferred — v2 ships built-in checks only.
 */

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFinding {
	check: string; // e.g. "locks"
	status: DoctorStatus;
	code: string; // stable machine code
	message: string;
	remediation?: string; // command or guidance
	/** When true, doctor --fix may call `fix`. */
	fixable: boolean;
	detail?: unknown;
}

export interface DoctorCheckContext {
	startDir: string;
	projectRoot: string;
	stateDir?: string;
	homeDir?: string;
	/**
	 * Absolute control-plane DB path. Always a resolved path string —
	 * `resolveDoctorContext` fails the whole command if path math cannot run.
	 * The file at this path may or may not exist — checks must existsSync.
	 * Never an open mutating connection.
	 */
	dbPath: string;
	dbRelPath: string;
	/** Injected clock for lingering-run tests. Defaults to Date.now. */
	now?: number;
}

export interface DoctorFixResult {
	/** True only when a write was attempted and the helper reported success. */
	attempted: boolean;
	message: string;
}

export interface DoctorCheck {
	id: string;
	/** Detection only — must not mutate. */
	run(ctx: DoctorCheckContext): Promise<DoctorFinding[]>;
	/**
	 * Optional deterministic repair for one fixable finding.
	 * Called only when `--fix` and `finding.fixable` and `finding.check === id`.
	 *
	 * Invariant: `fix` MUST re-validate its target before mutating. The handler
	 * iterates the original `detected` array even after `current = again`, so a
	 * later candidate may already have been removed (or become live). Specified
	 * helpers already do this (`removeCorruptLock` re-reads; `releaseLock`
	 * handles `not_locked`; harness sync is one harness+scope; worktree upsert
	 * is keyed by `planPath`). Future checks must preserve that: never assume
	 * the candidate is still in the same state as detect. Future `fixable`
	 * codes must also add a `findingKey` switch case with identifying detail —
	 * `findingKey` throws on `fixable` + empty identity (multi-field identities
	 * must return `""` if any required sub-field is empty, not a partial join).
	 */
	fix?(
		finding: DoctorFinding,
		ctx: DoctorCheckContext,
	): Promise<DoctorFixResult>;
}

export interface DoctorReport {
	ok: boolean; // true iff no fail findings remain after optional fixes
	checks: DoctorFinding[];
	fixed: Array<{ check: string; code: string; message: string }>;
}
