# Run-Context Ergonomics — Ambient Identity, Pointer, Composite, Pipe Warning

**Version:** 1.0
**Created:** August 24, 2026
**Status:** Draft — pending staff engineer review

---

## Executive Summary

Run-scoped commands still require callers to thread `--run` on every invocation. The execution-context resolver (`resolveRunExecutionContext`) already maps a known run id onto worktree and plan paths; only identity itself is missing. This slice adds a single ambient identity resolver with strict precedence (`--run` → `FIVEX_RUN` → unique linked-worktree mapping → compatible `.5x/current-run`), writes/clears a local focus pointer from `run init` / `run complete`, and introduces `5x phase finish` as fail-forward sugar over existing quality, protocol, checklist, and record handlers.

Queued or remote workers are out of scope and must keep receiving an explicit `run_id`. Pipe-context extraction stays for back-compat but loses its silent timeout. Bundled skills switch to `export FIVEX_RUN` plus `phase finish` while keeping granular recovery instructions.

### Scope

**In scope:**

- Strict ambient run resolution for every command that accepts `--run`.
- Linked-worktree inference from canonical `plans.worktree_path` (no per-worktree pointer registry).
- Control-plane-local `.5x/current-run` write on init and conditional clear on complete.
- Ambient marker + source on `5x run list`.
- `5x phase finish` composite with fail-forward sub-step reporting and idempotent resume.
- Stderr warning when implicit piped-context read times out.
- Bundled skill updates (`FIVEX_RUN`, `phase finish`, granular fallbacks).

**Out of scope:**

- **`--phase` / `--iteration` / `--session` inference** — wrong defaults are wrong writes; remain explicit.
- **`5x phase start`** — deferred until remaining plumbing is measured.
- **Removing pipe-context support** — keep the channel; only the silent timeout goes away.
- **Per-worktree pointer files, workspace-focus tables, execution-target registries.**
- **Ambient resolution inside prompt-queue / invocation-registry workers** — those slices pass explicit `run_id`.
- **Breaking output-format changes** — owned by `09-output-normalization-release.plan-input.md`.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **New identity module, keep execution resolver unchanged** | `resolveRunExecutionContext` maps *known* run id → dirs. Identity is a different question. Do not overload that function. |
| **Checkout identity = `git rev-parse --show-toplevel` + `realpathExisting`** | Nested invocation dirs, symlinks, and macOS `/var` aliases must match stored `worktree_path` values. Reuse `resolveCheckoutRoot`. |
| **Linked worktree = checkout root ≠ control-plane root** | Same predicate as `isLinkedWorktreeContext` (`worktree.handler.ts:107-117`). Covers git-linked and externally attached checkouts sharing one DB. |
| **Worktree inference only considers `status = 'active'` mappings** | Terminal runs must not steal implicit identity. `--run` / `FIVEX_RUN` may still select them. |
| **Pointer is last implicit fallback and must be compatible** | A shared file must never select a run mapped to another linked checkout. Ambiguity never consults the pointer. |
| **Optional-run commands keep no-run behavior when identity is absent** | `quality run`, `diff`, `template render`, and `protocol validate` without `--record` currently work without a run. Ambient fill-in is additive; missing identity is not a new error. |
| **Pipe `run_id` ranks after pointer** | Pipe support stays (out of scope to remove) but is no longer the reliable default. |
| **Composite calls handler cores, not subprocesses** | Preserves identical step names and `UNIQUE(run_id, step_name, phase, iteration)` keys. One stdout envelope. |
| **Composite records quality only on pass/skip** | Recording a failed `quality:check` at an explicit iteration would poison resume (`INSERT OR IGNORE`). Granular `quality run --record` is unchanged. |
| **Composite exit code = failing sub-step’s existing code** | No new composite-only exit code. `QUALITY_FAILED` (already named in `101-cli-primitives.md`) is used when gates return `passed: false`. |
| **`export_hint` on `run init` envelope** | Cheap additive nudge for the `FIVEX_RUN` idiom; skills should still export explicitly. |
| **Skill edits go through `src/skills/base/*.tmpl.md`** | Harness install/sync is the supported refresh path; do not hand-edit installed assets. |

### References

- [`docs/v2/204-run-context-ergonomics.md`](../../v2/204-run-context-ergonomics.md) — canonical resolution and composite design.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.2 local pointer; §3a forward-compat.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — idempotent primitives; Layer 2 independence.
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — current run / quality / protocol contracts.
- Plan input: [`docs/v2/plan-inputs/02-run-context-ergonomics.plan-input.md`](../../v2/plan-inputs/02-run-context-ergonomics.plan-input.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Ambient identity resolver](#phase-1-ambient-identity-resolver)
5. [Phase 2: Focus pointer lifecycle](#phase-2-focus-pointer-lifecycle)
6. [Phase 3: Wire resolver into run-scoped commands](#phase-3-wire-resolver-into-run-scoped-commands)
7. [Phase 4: `run list` marker and two-worktree integration](#phase-4-run-list-marker-and-two-worktree-integration)
8. [Phase 5: `5x phase finish` composite](#phase-5-5x-phase-finish-composite)
9. [Phase 6: Pipe-context timeout warning](#phase-6-pipe-context-timeout-warning)
10. [Phase 7: Skills, docs, forward-compat](#phase-7-skills-docs-forward-compat)
11. [Files Touched](#files-touched)
12. [Tests](#tests)
13. [Not In Scope](#not-in-scope)
14. [Estimated Timeline](#estimated-timeline)
15. [Provenance](#provenance)

---

## Overview

Today every run-scoped command either requires `--run` at the adapter (`requiredOption`) or fails in the handler when the flag is missing. The only implicit channel is piped envelopes, and that channel races a 200ms stdin timeout then silently assumes no upstream (`src/pipe.ts:94-113`). Linked worktrees already share one control-plane DB and already store canonical `plans.worktree_path` mappings; those mappings are unused for identity.

**Current behavior:**

- `resolveRunExecutionContext` (`src/commands/run-context.ts:91-211`) requires a run id; it never discovers one.
- `--run` is `requiredOption` on `run complete` / `reopen` / `relink` / `watch` (`src/commands/run-v1.ts:208,240,295,326`) and `commit` (`src/commands/commit.ts:21`).
- `run state` errors `Either --run or --plan is required` (`src/commands/run-v1.handler.ts:999-1000`).
- `invoke` and `run record` accept a piped `run_id` then error if still missing (`src/commands/invoke.handler.ts:173-193`, `src/commands/run-v1.handler.ts:1202-1236`).
- `quality run`, `diff`, `template render`, and `protocol validate` treat `--run` as optional; no-run paths keep cwd-based behavior.
- `run list` returns id / plan / status / step_count with no focus marker (`src/commands/run-v1.handler.ts:1436-1459`).
- `run init` does not write a focus file; `run complete` does not clear one.
- No `phase` command is registered in `src/bin.ts:85-101`.
- Bundled skills thread `--run $RUN` on every call (e.g. `src/skills/base/5x-phase-execution/SKILL.tmpl.md:210-252`).

**New behavior:**

- Omitting `--run` resolves identity by strict precedence and then calls the existing execution resolver unchanged.
- Two linked (or externally attached) worktrees sharing one DB each resolve their own uniquely mapped active run with no flag, env, or pointer coordination.
- A shared `.5x/current-run` never selects a run mapped to a different linked checkout. Multiple active mappings to one checkout fail with candidates.
- `FIVEX_RUN` pins a session even when another process rewrites the pointer.
- Completing run A leaves the pointer alone if it now names run B.
- `5x run list` marks the ambiently resolved run and its source without changing persisted `status`.
- `5x phase finish` runs quality → author protocol validate/record → checklist, reports `completed` / `failed` / `skipped` per sub-step, and resumes successful steps for the same `(run, phase, iteration)`.
- A timed-out implicit pipe read prints one stderr line and never writes to stdout.
- Skills `export FIVEX_RUN` after `run init`, prefer `phase finish` in the hot loop, and keep granular recovery commands.

**Prerequisites:**

- None beyond shipped v1 plus area 201/203 (this slice does not consume doctor/lock APIs). May run in parallel with remaining recovery work.

---

## Design Decisions

**Identity is a new module; execution context stays a pure “given this run id” lookup.** `resolveRunExecutionContext` (`src/commands/run-context.ts:91-98`) is the single source of truth for worktree/plan/workdir once the id is known. Mixing discovery into it would hide precedence and make `--workdir` / missing-worktree errors harder to test. Add `src/commands/run-identity.ts` for discovery and `src/commands/run-pointer.ts` for the focus file. `run-context.ts` is not modified except possibly a re-export.

**Checkout identity is the git toplevel, canonicalized.** Compare `realpathExisting(resolveCheckoutRoot(startDir))` (`src/commands/control-plane.ts:198-201`) to `realpathExisting(plans.worktree_path)`. `listPlansByWorktreePath` (`src/db/operations.ts:109-125`) already uses that comparison; reuse it rather than string-matching stored paths. Nested dirs under a worktree (`wt/src/…`) resolve to `wt`. Symlinks and macOS `/var` vs `/private/var` follow `realpathExisting` (`src/paths.ts:26-45`).

**A checkout is “linked” when its toplevel is not the control-plane root.** Lift the private `isLinkedWorktreeContext` predicate (`src/commands/worktree.handler.ts:107-117`) into the identity module and share it. This treats git-linked worktrees and `worktree attach` of an external path the same: both share the root DB and have a distinct checkout path. Isolated-mode checkouts where checkout === control-plane root are *not* linked; they use `FIVEX_RUN` / pointer only.

**Worktree inference queries active runs only, via existing mappings.** For the current checkout:

1. `listPlansByWorktreePath(db, checkoutRoot)`
2. For each plan, `getActiveRunV1(db, plan.plan_path)` (`src/db/operations-v1.ts:329-341`)
3. Deduplicate by run id
4. 0 matches → no worktree source; 1 → use it; >1 → `RUN_CONTEXT_AMBIGUOUS` with every candidate id and remediation to pass `--run` or set `FIVEX_RUN`

Do not add a SQL table, pointer-per-worktree file, or new column. The pointer does not break this tie.

**Pointer compatibility is a linked-worktree constraint only.** When the command is running in a linked worktree and step 3 produced no unique match, reading `.5x/current-run` is allowed only if that run’s mapped worktree (canonical) equals *this* checkout, or the run has no mapping (legacy unmapped run). If the pointer names a run mapped to another checkout, missing run, or terminal run → error (`RUN_POINTER_INCOMPATIBLE` / `RUN_POINTER_STALE`), do not fall through to “none” and do not guess. On the main checkout (not linked), a valid pointer is used as-is even if the named run maps to a worktree — execution context then moves there, which is existing `resolveRunExecutionContext` behavior. `--run` and `FIVEX_RUN` may intentionally select a run mapped elsewhere.

**`FIVEX_RUN` is session identity, not a hint.** Invalid values (fail `SAFE_RUN_ID` in `src/run-id.ts:14-24`) or unknown ids error; they do not fall through to worktree/pointer. A completed run is still a valid `FIVEX_RUN` / `--run` selection (handlers such as `commit` continue to enforce `active` themselves at `src/commands/commit.handler.ts:109-115`).

**`--plan` stays an explicit selector and is resolved before ambient identity.** `run state --plan` keeps `getActiveRunV1` (`src/commands/run-v1.handler.ts:994-998`). Do not consult `FIVEX_RUN` or the pointer when `--plan` is present. If both `--run` and `--plan` are present, `--run` wins (today `--run` is checked first).

**Required-run vs optional-run.**

| Class | Commands | Missing identity |
|-------|----------|------------------|
| Required | `invoke`; `commit`; `run record` / `complete` / `reopen` / `relink` / `watch`; `run state` without `--plan`; `protocol validate --record`; `quality run --record`; `phase finish` | `RUN_CONTEXT_REQUIRED` (exit 1) with remediation naming `--run`, `FIVEX_RUN`, unique worktree mapping, and `.5x/current-run` |
| Optional | `quality run` (no `--record`); `diff`; `template render`; `protocol validate` (no `--record`) | Keep today’s no-run path. If identity *does* resolve, behave as if `--run` was passed |

**Pipe `run_id` is precedence 5, after the pointer.** `Removing implicit pipe-context support` is out of scope, so `run record` / `invoke` still accept upstream `run_id` when nothing above produced one. Pipe no longer beats `FIVEX_RUN` or a compatible pointer. Template-var injection from pipe (`extractPipeContext`) is unchanged aside from the timeout warning in Phase 6.

**Pointer I/O is a plain file at the control-plane state root.** Path: `join(controlPlaneRoot, stateDir, "current-run")` — same joining convention as locks (`src/lock.ts:35-38`). Contents: the run id, optional trailing newline, nothing else. No JSON, no UUID, no CAS. `run init` overwrites it after the run row exists (new or resumed). `run complete` reads the file and unlinks **iff** the trimmed contents equal the completed run id; otherwise it leaves the file. Do not take a lock; document the remaining TOCTOU as acceptable for a convenience file. Tests must cover “pointer now names B while completing A”.

**`run init` adds additive `export_hint`.** Success payload gains `export_hint: "export FIVEX_RUN=<id>"` (and the same string in text mode on stderr is acceptable but not required). This resolves the 204 §2.1 TODO in favor of an envelope field. Windows skills translate to `$env:FIVEX_RUN = '...'`.

**Ambiguous / incompatible errors list candidates and commands, never guess.** Stable codes:

| Code | When |
|------|------|
| `RUN_CONTEXT_REQUIRED` | Required-run command, nothing resolved (including absent pointer file) |
| `RUN_CONTEXT_AMBIGUOUS` | ≥2 active runs mapped to this checkout |
| `RUN_POINTER_INCOMPATIBLE` | Pointer names a run mapped to another linked checkout |
| `RUN_POINTER_STALE` | Pointer names a missing or terminal run |
| `RUN_POINTER_INVALID` | File present but empty / not a `SAFE_RUN_ID` |
| `RUN_ENV_INVALID` | `FIVEX_RUN` fails `SAFE_RUN_ID` or is unknown |

`detail` always includes `remediation` (string) and, for ambiguity, `candidates: string[]`.

**`phase finish` is sugar: three reported sub-steps, one envelope, existing keys.** Sub-steps, in order:

1. `quality` — same as `quality run --record --run <id> --phase <phase> --iteration <n>` except the composite **does not record** when `passed: false` (so the key stays reusable). `skipped: true` (config `skipQualityGates`) counts as success.
2. `protocol` — same as `protocol validate author --record --run <id> --step <step> --phase <phase> --iteration <n>` with `--no-phase-checklist-validate` for the schema/record half (checklist is the next sub-step). Input from `--input` or stdin, same as protocol validate (`src/commands/protocol.handler.ts:51-68`).
3. `checklist` — same `validatePhaseChecklist` logic currently inline at `src/commands/protocol.handler.ts:145-239`, exported as a result-returning function so the composite can report it without a second stdout envelope.

`--phase` and `--iteration` are **required** on the composite so resume keys are stable (`recordStep` auto-increments when iteration is omitted — `src/db/operations-v1.ts:141-143` — which would break resume). `--step` is required (author step name, typically from `template render`). `--run` is ambient-resolved. Do not infer phase.

**Resume skips only successful sub-steps.** Before executing a sub-step, `findExistingStep` (`src/db/operations-v1.ts:103-123`) for that `(run, step_name, phase, iteration)`:

- `quality:check` exists and `result_json.passed === true` or `skipped === true` → status `completed` (not re-executed); include existing `step_id`.
- author `--step` exists → protocol `completed`; checklist implied complete if that recorded result is author `complete`.
- Otherwise execute. Failed prior attempts that were *not* recorded (quality fail, schema fail, checklist incomplete) re-run.

Re-running after partial success must not insert a duplicate row (`recorded: false` is success, not a new write). Assert the same `step_id`.

**Fail-forward envelope and exit codes.** Always one JSON object on stdout. On any sub-step failure:

```json
{
  "ok": false,
  "error": {
    "code": "<failing sub-step code>",
    "message": "...",
    "detail": {
      "failing_step": "quality|protocol|checklist",
      "steps": [ /* every sub-step: name, status, step_id?, recorded?, error? */ ],
      "remediation": "..."
    }
  }
}
```

Statuses are `completed` | `failed` | `skipped`. Remaining sub-steps after a failure are `skipped`. Exit code is `exitCodeForError(code)` (`src/output.ts:73-76`): `QUALITY_FAILED` → 1 (add to map if missing); `INVALID_STRUCTURED_OUTPUT` → 7; `PHASE_CHECKLIST_INCOMPLETE` / `PHASE_NOT_FOUND` → 8. Granular commands keep their current envelopes (quality still returns `{ ok: true, data: { passed: false } }` when called directly).

**Quality `passed: false` is a composite failure with `QUALITY_FAILED`.** Granular `quality run` currently writes success with `passed: false` and exit 0 (`src/commands/quality-v1.handler.ts:235-249`). The composite stops the sequence; that is the verb’s job. Do not change granular quality exit behavior.

**Extract non-printing cores rather than spawning `5x`.** `runQuality` and `protocolValidate` both call `outputSuccess` (and protocol records *after* printing). The composite cannot call them as-is without corrupting stdout. Phase 5 extracts `runQualityCore` / `protocolValidateCore` / `evaluatePhaseChecklist` that return data or structured errors; existing handlers become thin wrappers. Cores must not write stdout. Recording failures in cores throw `RecordError` (already used at `src/commands/run-v1.handler.ts:157-159`) so the composite can fold them into the fail-forward envelope instead of a second JSON line.

**Add `--iteration` to `quality run` (additive).** Needed so the composite and granular `quality run --record --iteration N` share a key. Omit remains auto-increment (current behavior).

**Pipe timeout warning is stderr-only and injected at the timeout branch.** When `isStdinPiped()` and the 200ms race returns empty (`src/pipe.ts:110-113`), write one line to stderr, e.g. `Warning: no upstream envelope detected on stdin (timeout); continuing without piped context.` Default `warn` sink is `console.error` so unit tests can inject a mock. Never write this to stdout. TTY stdin (`!isStdinPiped`) stays silent. Successful reads stay silent.

**Skills change templates only; freshness is expected.** Edit `src/skills/base/*/SKILL.tmpl.md`. After ship, installed assets hash-mismatch until `5x harness sync` — that is the 201 contract, not a bug. Tests assert rendered skill text via `listSkills()` / `getDefaultSkillRaw()`, not files under `.opencode/` or `~/.cursor/`.

**Invocation workers are documentation-only in this slice.** State in `204` §3 and `200` §3.2/§3a that prompt-queue / invocation-registry workers receive explicit `run_id` and must not call the ambient resolver. No worker code exists yet (`03` / `05` slices).

---

## Architecture Overview

```
CLI adapters                         Handlers                         Identity
src/commands/run-v1.ts               run-v1.handler.ts                src/commands/run-identity.ts
src/commands/commit.ts               commit.handler.ts                  resolveAmbientRunId()
src/commands/invoke.ts               invoke.handler.ts                  listActiveRunsForCheckout()
src/commands/quality-v1.ts           quality-v1.handler.ts            src/commands/run-pointer.ts
src/commands/protocol.ts             protocol.handler.ts                read / write / clearIfMatch
src/commands/template.ts             template.handler.ts
src/commands/diff.ts                 diff.handler.ts                  Execution (unchanged)
src/commands/phase.ts  (new)         phase.handler.ts (new)           resolveRunExecutionContext()
        │                                    │
        │  opts.run (optional)               │  resolved run id
        └────────────────────────────────────┴──────────► worktree / plan / cwd

Precedence (strict):
  1. --run
  2. FIVEX_RUN
  3. unique active run mapped to this linked checkout (plans.worktree_path)
  4. compatible .5x/current-run
  5. pipe run_id (record / invoke only)
  6. required → RUN_CONTEXT_REQUIRED ; optional → no-run path

phase finish (cores, no nested CLI):
  quality core ──record quality:check──► protocol core ──record --step──► checklist
       │                                      │                              │
       └──────── fail-forward envelope (completed | failed | skipped) ───────┘

Pointer:
  run init  ──write──►  <controlPlaneRoot>/<stateDir>/current-run
  run complete ──unlink iff contents === completed id──► same file
```

Ambient source values surfaced on `run list`: `flag` is never used there (list has no `--run`); sources are `environment` | `worktree` | `pointer`. Commands that resolved via `--run` do not need to advertise source except internally.

---

## Phase 1: Ambient identity resolver

**Completion gate:** Unit tests cover precedence, canonical worktree matching (symlink + nested cwd), ambiguity with listed candidates, incompatible pointer rejection, `FIVEX_RUN` over pointer, and optional vs required missing-identity — with no CLI adapters changed yet.

### 1.1 Types and `resolveAmbientRunId`

**File:** `src/commands/run-identity.ts` (new)

```typescript
export type AmbientRunSource =
	| "flag"
	| "environment"
	| "worktree"
	| "pointer"
	| "pipe"
	| "none";

export type AmbientRunErrorCode =
	| "RUN_CONTEXT_REQUIRED"
	| "RUN_CONTEXT_AMBIGUOUS"
	| "RUN_POINTER_INCOMPATIBLE"
	| "RUN_POINTER_STALE"
	| "RUN_POINTER_INVALID"
	| "RUN_ENV_INVALID";

export interface AmbientRunRequest {
	explicitRun?: string;
	/** Piped run_id already extracted by the caller. Ranked last. */
	pipeRunId?: string;
	required: boolean;
	startDir?: string;
	env?: NodeJS.Dict<string>;
	db: Database;
	controlPlane: ControlPlaneResult;
}

export type AmbientRunResult =
	| {
			ok: true;
			runId: string;
			source: Exclude<AmbientRunSource, "none">;
	  }
	| {
			ok: true;
			runId: undefined;
			source: "none";
	  }
	| {
			ok: false;
			error: {
				code: AmbientRunErrorCode;
				message: string;
				detail?: {
					remediation?: string;
					candidates?: string[];
					path?: string;
					run_id?: string;
				};
			};
	  };

export function resolveAmbientRunId(req: AmbientRunRequest): AmbientRunResult;

export function isLinkedWorktreeCheckout(
	controlPlane: ControlPlaneResult,
	startDir?: string,
): boolean;

export function listActiveRunsForCheckout(
	db: Database,
	checkoutRoot: string,
): Array<{ runId: string; planPath: string; worktreePath: string }>;
```

Implementation notes:

- `explicitRun` present → `validateRunId` semantics without calling `outputError` (return `RUN_ENV_INVALID`-shaped error or a dedicated invalid-flag path). Prefer returning `ok: false` and letting handlers call `outputError`, matching `resolveRunExecutionContext`.
- Read `env?.FIVEX_RUN ?? process.env.FIVEX_RUN` only when `explicitRun` is absent.
- `isLinkedWorktreeCheckout` is the moved `isLinkedWorktreeContext` body. `worktree.handler.ts` should import it (Phase 3 can do the import swap if Phase 1 keeps a local re-export to avoid a large worktree diff).
- `listActiveRunsForCheckout` uses `listPlansByWorktreePath` + `getActiveRunV1`; no new SQL.
- Pointer read lives in `run-pointer.ts` (Phase 2). Phase 1 may accept an injected `readPointer?: () => string | null` **or** implement pointer read against a temp path in tests via `controlPlane.stateDir`. Prefer implementing pointer *read* here against the real helper added in Phase 2 if both files land together; if splitting PRs, stub the reader behind an optional `pointer` callback on `AmbientRunRequest` so Phase 1 tests do not depend on filesystem layout. **Preferred in this repo: land `run-pointer.ts` in the same phase as the resolver’s pointer branch** (small file). If the implementer splits, Phase 1 tests inject `readPointer`.

**File:** `src/commands/run-pointer.ts` (new — land with Phase 1 or 2; required before Phase 1 pointer tests if not injected)

See Phase 2.1 for the API. Phase 1 unit tests that cover precedence 4 should call `writePointer` into a temp `stateDir`.

**File:** `src/index.ts` — export the new types and `resolveAmbientRunId` next to existing run-context consumers (after the lock exports around `:80-99`, or beside path helpers).

- [ ] Add `run-identity.ts` with the types and functions above.
- [ ] Implement `listActiveRunsForCheckout` on top of `listPlansByWorktreePath` + `getActiveRunV1`.
- [ ] Implement precedence 1–3 and required/optional none without pointer if pointer helpers are deferred; otherwise 1–6.
- [ ] Export from `src/index.ts`.
- [ ] Do not change any command adapter in this phase.

### 1.2 Unit tests

**File:** `test/unit/commands/run-identity.test.ts` (new)

Use in-memory DB + temp directories like `test/unit/commands/run-context.test.ts:20-50`. Inject `startDir` / `env`. Create two temp dirs with distinct `realpath` values as fake worktree roots (they need not be git repos for the mapping query). Control plane root = tmp.

- [ ] `--run` wins over `FIVEX_RUN`, worktree mapping, and pointer.
- [ ] `FIVEX_RUN` wins over worktree mapping and pointer.
- [ ] Unique active mapping to `startDir`’s checkout (via `controlPlane` + mocked checkout root — if `resolveCheckoutRoot` needs a real git toplevel, either init a git repo + worktree in the unit test or add an injectable `checkoutRoot` on `AmbientRunRequest` for tests; **prefer injectable `checkoutRoot?: string`** to keep this file under `--concurrent` and off git).
- [ ] Two active runs mapped to the same canonical path → `RUN_CONTEXT_AMBIGUOUS` with both ids, no pointer consult (pointer file can name a third id; must not be chosen).
- [ ] Linked checkout with zero mappings + pointer to a run mapped elsewhere → `RUN_POINTER_INCOMPATIBLE`.
- [ ] Linked checkout with zero mappings + pointer to the unique run mapped *here* → `source: "pointer"` (compatibility success).
- [ ] Non-linked checkout (checkoutRoot === controlPlaneRoot) uses pointer even if that run maps to another path.
- [ ] `required: false` and no signals → `{ ok: true, runId: undefined, source: "none" }`.
- [ ] `required: true` and no signals → `RUN_CONTEXT_REQUIRED` with remediation mentioning `--run`, `FIVEX_RUN`, worktree, and `.5x/current-run`.
- [ ] Canonical match: symlink worktree path stored in DB vs real `startDir` (use `symlinkSync`).
- [ ] Nested `startDir` under a worktree matches the toplevel mapping when `checkoutRoot` is the toplevel (inject toplevel).
- [ ] `FIVEX_RUN` unknown id → `RUN_ENV_INVALID`, no fallback.
- [ ] Pipe id used only when 1–4 produced none (`pipeRunId` set, no flag/env/mapping/pointer).
- [ ] Terminal run in mapping is ignored for worktree inference; pointer to that terminal run → `RUN_POINTER_STALE`.

---

## Phase 2: Focus pointer lifecycle

**Completion gate:** `run init` writes `<stateDir>/current-run`; `run complete` deletes it only when contents still match; unit tests cover overwrite, mismatch leave-in-place, missing file, and malformed file.

### 2.1 Pointer helpers

**File:** `src/commands/run-pointer.ts` (new)

```typescript
export const CURRENT_RUN_FILENAME = "current-run";

export function currentRunPath(
	controlPlaneRoot: string,
	stateDir: string,
): string {
	return join(controlPlaneRoot, stateDir, CURRENT_RUN_FILENAME);
}

export function readPointer(path: string): string | null; // missing → null
export function writePointer(path: string, runId: string): void;
export function clearPointerIfMatch(path: string, runId: string): boolean;
```

`readPointer`: if missing, `null`. If present, trim whitespace; empty → treat as invalid at the identity layer (`RUN_POINTER_INVALID`), so this helper can return `""` or throw; prefer returning the raw trimmed string (including `""`) and let `resolveAmbientRunId` classify. `writePointer`: `mkdirSync` parent `recursive: true`, write `runId + "\n"` (POSIX text). `clearPointerIfMatch`: read, compare, `unlinkSync` only on equality; return whether unlinked. Ignore `ENOENT` on unlink.

- [ ] Implement helpers with no logging and no `process.exit`.
- [ ] Unit tests in `test/unit/commands/run-pointer.test.ts` (new): write/read round-trip; clear matching; refuse to clear mismatch; missing file clear is no-op; parent dir created on write.

### 2.2 `run init` writes the pointer

**File:** `src/commands/run-v1.handler.ts`, `runV1Init` success paths at `:967-978` (new run) and the resumed-run `outputSuccess` above it (~`:930-960` — both new and resume must write). After the run id is known and the row exists, `writePointer(currentRunPath(projectRoot, stateDir), runId)`.

Add `export_hint: \`export FIVEX_RUN=${runId}\`` to both success payloads.

- [ ] Write pointer for new and resumed runs.
- [ ] Include `export_hint` on the JSON payload (text formatter may ignore unknown fields via `formatGenericText`).
- [ ] If pointer write fails (EACCES), fail the command (`outputError` / wrap) — a half-inited run without a pointer is worse than a loud error. Keep this a hard error, not a warning.

### 2.3 `run complete` clears conditionally

**File:** `src/commands/run-v1.handler.ts`, `runV1Complete` after `completeRun` (`:1350`) and lock release (`:1354-1356`), before `outputSuccess` (`:1358-1362`).

```typescript
clearPointerIfMatch(
	currentRunPath(projectRoot, controlPlane?.stateDir ?? ".5x"),
	params.run,
);
```

Do **not** clear on `reopen`. Abort (`--status aborted`) is still a completion of *this* run: clear iff match.

- [ ] Clear only on match.
- [ ] Completing A while the file names B leaves B.
- [ ] Missing file is not an error.

### 2.4 Tests

**File:** `test/unit/commands/run-pointer.test.ts` (new) plus handler-level tests.

`runV1Init` / `runV1Complete` currently go through `resolveDbContext` and git. Prefer:

- Unit: pointer helpers (above).
- Integration (can live in Phase 2 or 4): `5x run init` creates `.5x/current-run`; second `run init` for another plan overwrites; `run complete` of the named run deletes; `run complete` of a different run does not.

Existing init tests: `test/integration/commands/run-v1.test.ts` and `run-init-worktree.test.ts`. Extend one of them rather than a third copy of `setupProject` if feasible.

- [ ] Pointer helpers unit tests.
- [ ] Integration: init writes; complete matching clears; complete other leaves; resume init overwrites.

---

## Phase 3: Wire resolver into run-scoped commands

**Completion gate:** Every command that accepts `--run` uses `resolveAmbientRunId` after DB/control-plane resolution; `requiredOption("--run")` is gone; existing `--run <id>` call sites still pass; required-run commands without identity exit `RUN_CONTEXT_REQUIRED`; optional-run commands without identity keep no-run behavior.

### 3.1 Shared handler helper

**File:** `src/commands/run-identity.ts` — add:

```typescript
export function outputAmbientError(
	result: Extract<AmbientRunResult, { ok: false }>,
): never {
	outputError(result.error.code, result.error.message, result.error.detail);
}
```

Handlers:

```typescript
const ambient = resolveAmbientRunId({
	explicitRun: params.run,
	required: true, // or false
	startDir: params.startDir,
	db,
	controlPlane,
});
if (!ambient.ok) outputAmbientError(ambient);
params.run = ambient.runId; // may be undefined when required: false
```

Call this **after** `resolveDbContext` / `getDb` so `db` and `controlPlane` exist, and **before** `resolveRunExecutionContext`.

### 3.2 Adapter: `--run` is never required at parse time

**Files and current `requiredOption` sites:**

| File | Lines | Change |
|------|-------|--------|
| `src/commands/run-v1.ts` | `complete` `:208`, `reopen` `:240`, `relink` `:295`, `watch` `:326` | `.option("-r, --run <id>", "Run ID (or ambient context)")` |
| `src/commands/commit.ts` | `:21` | same |
| `src/commands/run-v1.ts` | `state` `:107`, `record` `:147` | already optional; update help text |
| `src/commands/invoke.ts` | `:20-23` | already optional; update help |
| `src/commands/quality-v1.ts` | `:37` | help: optional except with `--record` |
| `src/commands/protocol.ts` | `:53`, `:111` | help: optional except with `--record` |
| `src/commands/template.ts` | `:38-41` | help: ambient when omitted |
| `src/commands/diff.ts` | `:26-29` | help: ambient when omitted |

Param types: `RunCompleteParams.run`, `RunReopenParams.run`, `RunRelinkParams.run`, `CommitParams.run`, watch params — change `run: string` to `run?: string` (`src/commands/run-v1.handler.ts:130-137`, `src/commands/commit.handler.ts:22-23`). Handlers assign the resolved id before `validateRunId`.

Help examples may show flag-less forms (`5x run complete`, `5x commit -m "…" --all-files`) in addition to explicit `--run`.

- [ ] Replace every `requiredOption` for `--run`.
- [ ] Update help strings to name `--run`, `FIVEX_RUN`, worktree mapping, and `.5x/current-run`.
- [ ] Widen param types to `run?: string`.

### 3.3 Handler call sites

Apply the helper at each site that currently requires or optionally uses a run id. After resolution, existing `resolveRunExecutionContext` calls stay as they are.

| Handler | File:line (current) | `required` | Notes |
|---------|---------------------|------------|-------|
| `runV1State` | `run-v1.handler.ts:987-1001` | true iff `!params.plan` | `--plan` first; skip ambient |
| `runV1Record` | `:1231-1237` | true | After pipe merge: set `pipeRunId` from `ctx.runId`, then ambient (pipe is rank 5). Order: parse pipe → ambient(`explicitRun: params.run`, `pipeRunId`) → validate |
| `runV1Complete` | `:1288` | true | |
| `runV1Reopen` | `:1369` | true | |
| `runV1Relink` | `:1494` | true | Not in 204’s example list but takes `--run`; include for identical precedence |
| `runV1Watch` | `:1605` | true | |
| `runCommit` | `commit.handler.ts:97` | true | |
| `invokeAgent` | `invoke.handler.ts:173-194` | true | Same pipe-then-ambient pattern as record |
| `runQuality` | `quality-v1.handler.ts:104` | `Boolean(params.record)` | If `!params.run && !params.record`, still *try* ambient with `required: false`; on hit, take the run-scoped path (workdir/config). On miss, keep cwd path (`:180-186`) |
| `protocolValidate` | `protocol.handler.ts:319-325` | `Boolean(params.record)` | Same optional fill-in when not recording |
| `templateRender` | `template.handler.ts:74-80` | false | Optional fill-in enables run-aware fields without `--run` |
| `runDiff` | `diff.handler.ts` (~`:101`) | false | Optional fill-in diffs the mapped worktree |

`validateRunId` remains after a concrete id is chosen.

For `invoke` / `record` pipe ordering: today they set `params.run ??= ctx.runId` then error. Change to pass `pipeRunId: ctx.runId` into the resolver so `FIVEX_RUN` still wins.

Quality `--record` without identity: today warns on stderr after output (`quality-v1.handler.ts:53-58`). After this phase, identity is resolved *before* gates when `--record` is set, so missing identity is `RUN_CONTEXT_REQUIRED` **before** running gates (fail closed). That is stricter and correct for recording.

- [ ] Wire every row in the table.
- [ ] Swap `worktree.handler.ts` `isLinkedWorktreeContext` to the shared helper if not done in Phase 1.
- [ ] `run state --plan` does not read `FIVEX_RUN` or the pointer (unit or integration assertion).

### 3.4 Tests

**Files:**

- Update `test/integration/commands/invoke.test.ts:595-618` — “without `--run`” still fails in a repo with no pointer, no `FIVEX_RUN`, and no mapping; add a sibling test that succeeds with `FIVEX_RUN` and with a pointer file.
- Update `test/integration/commands/quality-record.test.ts` — `--record` without identity still fails, but with code `RUN_CONTEXT_REQUIRED` (or ambient equivalent) rather than a post-hoc stderr warning, when no pointer exists.
- New `test/unit/commands/run-identity-wiring.test.ts` **or** extend handler unit tests: `commit` / `runV1State` with injected db + pointer.
- Existing `--run` tests must keep passing (no behavior change when the flag is present).

- [ ] Flag-present tests unchanged.
- [ ] Required-run missing identity → `RUN_CONTEXT_REQUIRED`.
- [ ] `FIVEX_RUN` satisfies `invoke` / `commit` / `run state` without `--run`.
- [ ] Pointer satisfies the same on the main checkout.
- [ ] `run state --plan` ignores a conflicting `FIVEX_RUN`.
- [ ] Optional `diff` / `quality run` without identity still exit 0 in a bare project.

---

## Phase 4: `run list` marker and two-worktree integration

**Completion gate:** `run list` JSON/text mark exactly one focused run and its source; two real linked (or attached) worktrees sharing one DB each run a representative command without `--run` / `FIVEX_RUN` / coordinating the pointer; a shared pointer cannot make worktree A select worktree B’s run.

### 4.1 `run list` ambient marker

**File:** `src/commands/run-v1.handler.ts` `runV1List` (`:1436-1459`) and `formatListText` (`:706-760`).

After `listRuns`, call `resolveAmbientRunId({ required: false, db, controlPlane, startDir })`. If `ok && runId`, add to that element only:

```typescript
ambient: true,
ambient_source: "environment" | "worktree" | "pointer";
```

Do not add `ambient: false` on others (keep payloads small). Do not change `status`. Text table: add a `Focus` column (`*` or source name) **or** prefix the focused id with `*`. Prefer an extra column `Focus` with values `env` / `worktree` / `pointer` / empty so `--text` stays parseable.

`runV1List` currently does not destructure `controlPlane` (`:1437`). Use `const { config, db, controlPlane } = await resolveDbContext()`.

- [ ] JSON marker + source on the focused run only.
- [ ] Text column for focus.
- [ ] No marker when resolution fails or source is `none`.
- [ ] Marker is independent of `status: "active"` (a focused completed run via `FIVEX_RUN` still shows `status: completed` plus ambient marker).

### 4.2 Two-worktree integration tests

**File:** `test/integration/commands/run-ambient-context.test.ts` (new)

Setup (use `cleanGitEnv()`, `stdin: "ignore"`, `timeout: 30000`):

1. Temp git repo; `5x init`; two plans; `git worktree add` two directories **or** `5x run init --worktree` twice so mappings exist.
2. Do not set `FIVEX_RUN`. Write pointer to run A’s id at the **root** `.5x/current-run`.
3. From worktree B (unique mapping to run B): `5x run state` (no `--run`) returns run B; `5x run list` marks B with `ambient_source: "worktree"`.
4. From worktree A: `run state` returns run A even though the pointer also names A (source may be `worktree` not `pointer` — assert run id, not source, when both would agree).
5. From worktree B, point the shared pointer at A: `run state` still returns B (worktree rank 3).
6. From worktree B, clear B’s mapping (or use a third checkout with no mapping): `run state` with pointer-to-A fails `RUN_POINTER_INCOMPATIBLE`.
7. `FIVEX_RUN=A` from worktree B: `run state` returns A (env wins).
8. Two active runs mapped to B: `run state` from B fails `RUN_CONTEXT_AMBIGUOUS` listing both ids; pointer does not break the tie.
9. Representative optional command: from B, `5x diff` (no `--run`) diffs B’s worktree (non-empty or `--stat` against a known file). `5x quality run` executes with B’s mapping when gates are `echo ok`.
10. External attach: second clone/worktree path not under `.5x/worktrees/` mapped via `worktree attach` or `run init --worktree <abs>`; same unique-run resolution.

Reuse helpers from `test/integration/commands/run-scoped-context.test.ts` / `run-init-worktree.test.ts` where possible.

- [ ] Shared-DB two-worktree isolation without flags.
- [ ] Pointer cannot cross linked checkouts.
- [ ] `FIVEX_RUN` overrides pointer and worktree.
- [ ] Ambiguity lists candidates.
- [ ] `run list` source is `worktree` when invoked from a uniquely mapped checkout even if the pointer names the same or a different run.
- [ ] Completing A does not delete a pointer that names B (if not covered in Phase 2 integration).

---

## Phase 5: `5x phase finish` composite

**Completion gate:** `5x phase finish --phase P --iteration N --step S` with author JSON on stdin/file runs quality → protocol record → checklist; partial rerun skips successful recorded steps; failed quality does not insert `quality:check`; stdout is a single envelope; exit code matches the failing sub-step.

### 5.1 Extract non-printing cores

**File:** `src/commands/quality-v1.handler.ts`

Extract `runQualityCore(params): Promise<{ passed: boolean; results: …; skipped?: boolean; workdir: string }>` from `runQuality` (`:89-251`). `runQuality` calls the core then `outputSuccess` + `autoRecord`. Core does not write stdout. Add optional `iteration?: number` to `QualityParams` (`:30-36`).

When `params.record` and iteration is provided, `recordStepInternal` must receive it (`autoRecord` at `:64-69` currently omits iteration).

**File:** `src/commands/quality-v1.ts` — add `--iteration <n>` with `intArg("--iteration")`, pass through.

**File:** `src/commands/protocol.handler.ts`

- Export `evaluatePhaseChecklist(params): { ok: true } | { ok: false; code: string; message: string }` replacing the `outputError` calls inside `validatePhaseChecklist` (`:145-239`). Keep `protocolValidate` calling it and `outputError` on `ok: false` so granular behavior is identical.
- Extract `protocolValidateCore(params): Promise<{ role; valid; result; warnings: string[] }>` for parse + schema validate **without** printing or recording or checklist. `protocolValidate` becomes: core → checklist (if author complete) → `outputSuccess` → record.

**File:** `src/commands/protocol.handler.ts` `isNumericPhaseRef` is already exported (`:121`). Keep it.

- [ ] `runQuality` / `protocolValidate` stdout and exit behavior unchanged (existing tests).
- [ ] Cores have no `outputSuccess` / `outputError` (checklist helper returns instead of throwing).
- [ ] `quality run --iteration N --record` writes that iteration.

### 5.2 Composite handler and adapter

**Files:** `src/commands/phase.ts` (new adapter), `src/commands/phase.handler.ts` (new)

```typescript
export interface PhaseFinishParams {
	phase: string;
	iteration: number;
	step: string;
	run?: string;
	input?: string;
	recordStep?: string; // quality step name, default "quality:check"
	phaseChecklistValidate?: boolean; // default true
	startDir?: string;
}

export type PhaseFinishStepStatus = "completed" | "failed" | "skipped";

export interface PhaseFinishStep {
	name: "quality" | "protocol" | "checklist";
	status: PhaseFinishStepStatus;
	step_id?: number;
	recorded?: boolean;
	error?: { code: string; message: string; detail?: unknown };
}
```

Adapter: `5x phase finish` registered like `doctor` (top-level `phase` with subcommand `finish`, leaving room for a future `start`).

Flags: `--phase` (required), `--iteration` (required), `--step` (required), `--run` (optional), `--input` (optional; else stdin, same as protocol validate), `--record-step` (quality name), `--no-phase-checklist-validate`.

**File:** `src/bin.ts` — `registerPhase(program)` next to the other registers (`:85-101`).

Handler algorithm:

1. `resolveDbContext` / control plane; `resolveAmbientRunId({ required: true })`; `validateRunId`.
2. Build `steps: PhaseFinishStep[]` for `quality`, `protocol`, `checklist` (pre-fill `skipped` and overwrite as you go).
3. Quality: if successful existing `quality:check` (or `recordStep`) at `(run, phase, iteration)` → mark completed. Else `runQualityCore` with record-on-success-only. `passed: false` → fail envelope `QUALITY_FAILED`, skip the rest. On throw, map to the core’s code.
4. Protocol: if existing `--step` row → completed. Else read input (must not use `readUpstreamEnvelope`; this is payload stdin, same `readInput` as protocol). `protocolValidateCore`. Schema failure → `INVALID_STRUCTURED_OUTPUT` (or whatever `validateStructuredOutputOrThrow` uses today), skip checklist.
5. Checklist: if `phaseChecklistValidate === false` or non-numeric phase (`isNumericPhaseRef`) → `completed` (skipped gate, same as granular). Else `evaluatePhaseChecklist`. Failure → `PHASE_CHECKLIST_INCOMPLETE` / `PHASE_NOT_FOUND`; do not record the author step.
6. Record author step via `recordStepInternal` with the same fields as `protocolValidate` (`:405-413`). Idempotent `recorded: false` is success.
7. All completed → `outputSuccess({ run_id, phase, iteration, steps })`.

Stdin: quality does not read stdin; protocol payload does. Do not call `readUpstreamEnvelope` in this command.

Text formatter: one line per sub-step (`quality completed (step 12)`, `protocol failed …`).

- [ ] Register `phase finish`.
- [ ] Require `--phase`, `--iteration`, `--step`.
- [ ] Ambient `--run`.
- [ ] Single stdout envelope.
- [ ] Add `QUALITY_FAILED: 1` to `EXIT_CODE_MAP` in `src/output.ts:50-71` if not present (fallback is already 1).

### 5.3 Tests

**Files:** `test/unit/commands/phase-finish.test.ts` (new), `test/integration/commands/phase-finish.test.ts` (new)

Unit (handler + temp git repo / `startDir`, gates `echo ok` or `false`):

- [ ] Happy path: three `completed`; `quality:check` and author `--step` rows exist with the given iteration.
- [ ] Rerun same keys: no extra rows; `recorded: false`; quality core not re-invoked (spy `runQualityGates` or assert gate log not duplicated).
- [ ] Quality fail (`false` gate): envelope `QUALITY_FAILED`; no `quality:check` row; protocol/checklist `skipped`; rerun after switching gates to `echo ok` records success at the same iteration.
- [ ] Invalid author JSON: protocol `failed`; checklist `skipped`; no author step row.
- [ ] Incomplete checklist: protocol schema ok, checklist `failed` `PHASE_CHECKLIST_INCOMPLETE` (exit 8); no author record; quality already recorded; rerun skips quality.
- [ ] `--no-phase-checklist-validate`: checklist `completed` without reading plan checkboxes.
- [ ] Missing `--run` / env / pointer: `RUN_CONTEXT_REQUIRED` before gates.
- [ ] Explicit `--run` unchanged vs ambient.

Integration: spawn `5x phase finish` with `--input` file so stdin is not the protocol payload vs harness-piped-empty issue; assert stdout JSON and exit codes.

Granular regression: existing `test/integration/commands/quality-record.test.ts` and protocol validate tests still pass.

---

## Phase 6: Pipe-context timeout warning

**Completion gate:** Timed-out piped stdin emits exactly one stderr warning, stdout is unchanged (null envelope / command continues), TTY stdin stays silent; integration tests capture stderr.

### 6.1 Warning at the timeout branch

**File:** `src/pipe.ts` `readUpstreamEnvelope` (`:86-165`)

```typescript
export async function readUpstreamEnvelope(
	warn: (msg: string) => void = (m) => console.error(m),
): Promise<{ data: Record<string, unknown>; raw: string } | null> {
```

On `:110-113` (`first.done || !first.value` after the 200ms race), if `isStdinPiped()` (already true to reach this code), `warn("Warning: no upstream envelope detected on stdin (timeout); continuing without piped context.")` then `releaseLock` and `return null`.

Do not warn when `!isStdinPiped()` (early return `:90-92`).
Do not warn when a first chunk arrives but `raw.trim()` is empty after the full read (`:124-126`) — that is a successful empty body, not a timeout. Optional: same warning is acceptable; **prefer timeout-only** so tests can distinguish.

- [ ] Inject `warn` for unit tests.
- [ ] Timeout path warns; TTY path silent; valid JSON path silent.
- [ ] Warning goes to stderr only.

### 6.2 Tests

**File:** `test/integration/pipe.test.ts` and `test/helpers/pipe-read-helper.ts`

Extend the helper to print `{ ok, result, stderrCaptured }` or assert from the parent spawn’s `stderr`. Existing timeout/hang tests around `readUpstreamEnvelope` (~`:292+`): add `expect(stderr).toContain("no upstream envelope detected")` when stdin is piped-but-empty.

Add a unit-level test if you extract the timeout branch with a fake reader; otherwise subprocess is enough.

- [ ] Piped-empty: warning on stderr, `result: null`, exit 0 from helper.
- [ ] Valid piped envelope: no warning.
- [ ] TTY: no warning (`readUpstreamEnvelope` with `isTTY` true — existing seam test ~`:388-398`).
- [ ] `run record` / `invoke` with dangling stdin still succeed when `--run` or ambient identity is present; warning must not appear on stdout (JSON still one envelope). Cover via existing `test/integration/commands/run-record-pipe.test.ts` / `invoke-pipe.test.ts` plus a stderr assertion.

---

## Phase 7: Skills, docs, forward-compat

**Completion gate:** Rendered bundled skills export `FIVEX_RUN` after `run init`, call `phase finish` in the phase-execution hot loop, and still document granular `quality run` / `protocol validate` / `run record` recovery; v2/v1 docs match shipped behavior; plan-input points at this file.

### 7.1 Skill templates

**Files:**

- `src/skills/base/5x/SKILL.tmpl.md` — foundation examples that pass `--run $RUN` (`:131-141`, `:165`, `:235`): prefer ambient/`$FIVEX_RUN`; keep `--run` in a short “Recovery / explicit identity” note.
- `src/skills/base/5x-phase-execution/SKILL.tmpl.md` — after init, `export FIVEX_RUN=<id>` (from init envelope `run_id` or `export_hint`). Replace the post-author quality + protocol validate sequence (`:248-252` and the native validate at `:293-294`) with:

  ```bash
  echo "$RESULT" | 5x phase finish --phase $PHASE --iteration $ITERATION --step $STEP
  ```

  Keep Step 2a (quality retry) using granular `quality run` **or** re-invoking `phase finish` after a fix; document both, prefer `phase finish` so resume works. Retain `5x protocol validate author --record …` and `5x quality run --record …` in Recovery. Tools list (`:49-67`): add `5x phase finish`; mention `--run` is optional when ambient identity exists.
- `src/skills/base/5x-plan/SKILL.tmpl.md` — export after Step 1 init (`:100-113`); drop per-command `--run` in the happy path (`:121-137`, `:167`); keep `--run` on complete in Recovery if desired (complete is required-run but ambient should work). Plan workflow does **not** need `phase finish` (no implementation quality loop); optional.
- `src/skills/base/5x-plan-review/SKILL.tmpl.md` — export after init; happy-path commands omit `--run`; keep granular validate in recovery (`:102-114`, `:340-378`).
- `src/skills/base/5x-windows/SKILL.tmpl.md` — `$env:FIVEX_RUN = 'run_…'` after init (`:33-51`); PowerShell `phase finish` example.

Do not rewrite unrelated workflow judgment. Do not remove native vs invoke conditionals.

- [ ] `export FIVEX_RUN` / `$env:FIVEX_RUN` immediately after `run init` in every workflow skill that inits a run.
- [ ] Phase-execution hot loop uses `phase finish`.
- [ ] Recovery sections still show `quality run`, `protocol validate --record`, `run record`, `commit --run`.
- [ ] Tools lists mention ambient identity.

### 7.2 Skill tests

**Files:** `test/unit/harnesses/opencode-skills.test.ts`, `test/unit/harnesses/cursor-skills.test.ts`

Assert rendered content (via `listSkills()` / `getDefaultSkillRaw`):

- Combined skills contain `FIVEX_RUN` and `phase finish`.
- `5x-phase-execution` still contains `5x protocol validate` and `5x quality run` (granular fallback).
- Windows skill contains `FIVEX_RUN`.
- Existing token tests (`task_id=` / `resume=`, no `[[NATIVE_CONTINUE_PARAM]]`) still pass.

- [ ] OpenCode + Cursor rendered skills cover the new idiom and fallbacks.

### 7.3 Docs

| File | Change |
|------|--------|
| `docs/v2/204-run-context-ergonomics.md` | Status → Implemented (or “Specified — see plan 204”); resolve TODOs we decided (`export_hint` yes; pipe warn-when-timeout; composite exit = sub-step; sub-step set enumerated; `phase start` / phase inference remain deferred). |
| `docs/v2/200-overview.md` | §3.2 already describes ambient + pointer; add one sentence that invocation workers must be given `run_id` and must not use this resolver. |
| `docs/v2/204-run-context-ergonomics.md` §3 | Explicit sentence: prompt-queue and invocation-registry workers receive `run_id`; `.5x/current-run` and CWD inference are not dispatch/ownership mechanisms. |
| `docs/v1/101-cli-primitives.md` | Document optional `--run` + ambient precedence; `FIVEX_RUN`; `.5x/current-run`; `run list` ambient fields; new `5x phase finish` section; pipe timeout warning. |
| `docs/v1/100-architecture.md` | Layer 2: composites are sugar over independently useful primitives (one paragraph). |
| `docs/v2/plan-inputs/02-run-context-ergonomics.plan-input.md` | `Generated plan` → this file’s path; status `planned`. |
| `5x-cli/AGENTS.md` | One line: run-scoped commands resolve `--run` from `FIVEX_RUN` / unique worktree mapping / `.5x/current-run`; queue workers still pass `--run`. |

Do not edit `docs/v2/202-control-plane.md` beyond a pointer if 204 §3 already references it (dashboard reading the pointer is a later slice).

- [ ] Docs match shipped precedence, pointer rules, composite contract, pipe warning, and worker non-use of ambient identity.

---

## Files Touched

| File | Change |
|------|--------|
| `src/commands/run-identity.ts` | **New** — `resolveAmbientRunId`, checkout linkage, active-run listing |
| `src/commands/run-pointer.ts` | **New** — `current-run` read/write/clearIfMatch |
| `src/commands/phase.ts` | **New** — `5x phase finish` adapter |
| `src/commands/phase.handler.ts` | **New** — fail-forward composite |
| `src/commands/run-v1.ts` | `--run` optional on complete/reopen/relink/watch; help |
| `src/commands/run-v1.handler.ts` | Pointer write/clear; ambient resolve; `export_hint`; list marker; param types |
| `src/commands/commit.ts` | `--run` optional |
| `src/commands/commit.handler.ts` | Ambient resolve; `run?: string` |
| `src/commands/invoke.ts` | Help |
| `src/commands/invoke.handler.ts` | Ambient + pipe rank 5 |
| `src/commands/quality-v1.ts` | `--iteration`; help |
| `src/commands/quality-v1.handler.ts` | Core extract; ambient; iteration on record |
| `src/commands/protocol.ts` | Help |
| `src/commands/protocol.handler.ts` | Core extract; `evaluatePhaseChecklist`; ambient |
| `src/commands/template.ts` | Help |
| `src/commands/template.handler.ts` | Optional ambient fill-in |
| `src/commands/diff.ts` | Help |
| `src/commands/diff.handler.ts` | Optional ambient fill-in |
| `src/commands/worktree.handler.ts` | Use shared `isLinkedWorktreeCheckout` |
| `src/pipe.ts` | Timeout stderr warning; injectable `warn` |
| `src/bin.ts` | `registerPhase` |
| `src/index.ts` | Export identity/pointer APIs |
| `src/output.ts` | `QUALITY_FAILED` in exit map if missing |
| `src/skills/base/5x/SKILL.tmpl.md` | `FIVEX_RUN`; ambient examples |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | `phase finish` hot loop; granular recovery |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Export + drop happy-path `--run` |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Same |
| `src/skills/base/5x-windows/SKILL.tmpl.md` | `$env:FIVEX_RUN`; phase finish |
| `docs/v2/204-run-context-ergonomics.md` | Status, decided TODOs, worker non-use |
| `docs/v2/200-overview.md` | Worker explicit `run_id` |
| `docs/v1/101-cli-primitives.md` | Ambient `--run`, `phase finish`, pipe warning |
| `docs/v1/100-architecture.md` | Composite-as-sugar note |
| `docs/v2/plan-inputs/02-run-context-ergonomics.plan-input.md` | Generated plan pointer |
| `5x-cli/AGENTS.md` | Ambient identity + worker caveat |
| `test/unit/commands/run-identity.test.ts` | **New** |
| `test/unit/commands/run-pointer.test.ts` | **New** |
| `test/unit/commands/phase-finish.test.ts` | **New** |
| `test/integration/commands/run-ambient-context.test.ts` | **New** |
| `test/integration/commands/phase-finish.test.ts` | **New** |
| `test/unit/harnesses/opencode-skills.test.ts` | Idiom + fallback assertions |
| `test/unit/harnesses/cursor-skills.test.ts` | Same |
| `test/integration/pipe.test.ts` | Timeout warning |
| `test/helpers/pipe-read-helper.ts` | Surface stderr if needed |
| `test/integration/commands/invoke.test.ts` | Missing `--run` vs ambient |
| `test/integration/commands/quality-record.test.ts` | `--record` identity |

`src/commands/run-context.ts` is reused, not modified, unless a re-export is cleaner. `src/db/operations.ts` `listPlansByWorktreePath` is reused, not modified.

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `run-identity.ts` | Precedence 1–5; optional none; required none; ambiguity + candidates; incompatible pointer; stale/invalid pointer; `FIVEX_RUN` invalid; canonical symlink/nested checkout via injected root |
| Unit | `run-pointer.ts` | Write/read; clear match; refuse mismatch; missing file |
| Unit | `phase-finish` handler | Happy path keys; resume skip; quality fail not recorded; protocol/checklist failures; `--no-phase-checklist-validate` |
| Unit | `evaluatePhaseChecklist` | Same fail-closed/fail-open cases as current protocol tests |
| Unit | skills (OpenCode/Cursor) | `FIVEX_RUN`, `phase finish`, granular fallbacks still present |
| Integration | `run init` / `complete` | Pointer write; conditional clear; `export_hint` |
| Integration | two worktrees | Unique mapping per checkout; pointer cannot cross; `FIVEX_RUN` override; ambiguity; `run list` source; `diff`/`quality`/`state` without `--run` |
| Integration | `phase finish` CLI | `--input` happy path; exit codes; single JSON envelope |
| Integration | pipe timeout | Stderr warning; stdout not polluted; TTY silent |
| Integration | invoke / quality-record | Flag-less failure without ambient; success with `FIVEX_RUN` / pointer |
| Regression | existing `--run` tests | Explicit flag behavior unchanged |

Edge cases the implementer must not skip: symlink `worktree_path`; nested cwd under a worktree; two plans → one checkout; pointer rewritten during complete; `FIVEX_RUN` of a completed run on `run state`; optional `quality run` with no control plane.

---

## Not In Scope

- **`--phase` / `--iteration` / `--session` ambient defaults** — 204 §2.1 TODO; wrong defaults corrupt idempotency keys. Revisit after composites are in production.
- **`5x phase start`** — 204 §2.2; measure remaining `template render` overhead first (plan-input handoff #2).
- **Removing `extractPipeContext` / pipe run_id** — back-compat; this slice only unsilences the timeout.
- **Per-worktree `current-run` files or a `workspace_focus` table** — isolation is inference from `plans.worktree_path`.
- **Dashboard “focused run” reading the pointer** — plan-input handoff #1; `04-control-plane-dashboard`.
- **Prompt-queue / invocation-registry dispatch using CWD or the pointer** — `03` / `05`; workers get explicit `run_id`.
- **Execution-target registry** (containers, VMs, remote sandboxes).
- **Breaking text/JSON output changes** — `09-output-normalization-release` / `205`.
- **Changing granular `quality run` to exit non-zero on `passed: false`** — composite-only `QUALITY_FAILED`.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Ambient identity resolver + unit tests | 1.5 days |
| 2 | Pointer file + init/complete lifecycle | 1 day |
| 3 | Wire all `--run` commands; adapter optionality | 2 days |
| 4 | `run list` marker; two-worktree integration | 1.5 days |
| 5 | Quality/protocol cores + `phase finish` | 2 days |
| 6 | Pipe timeout warning | 0.5 day |
| 7 | Skills, docs, skill tests | 1.5 days |
| **Total** | | **~10 days** |

Phases 1–2 are sequential. Phase 6 can overlap with 4–5. Phase 7 depends on 3 and 5 (skill examples must match real flags).

---

## Provenance

Implements v2 area #4 (`docs/v2/204-run-context-ergonomics.md`) from plan input `docs/v2/plan-inputs/02-run-context-ergonomics.plan-input.md`. Builds on the shipped v1 execution-context resolver (`src/commands/run-context.ts`) and plan/worktree mappings (`plans.worktree_path`) without waiting on prompt-queue or dashboard slices. Suggested next slice: `03-prompt-queue-foundation.plan-input.md`, which must pass explicit `run_id` into workers and must not call `resolveAmbientRunId` for dispatch.
