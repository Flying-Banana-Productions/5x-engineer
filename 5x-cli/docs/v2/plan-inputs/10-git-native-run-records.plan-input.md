# Plan input: Git-native run records and progress resolution

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-git-native-run-records` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-28 |

---

## One-line goal

Completed-work history (run summary, recorded steps, decisions) is committed to the repository on the plan branch, `plan list` / `plan phases` report progress from the most advanced git ref rather than the checked-out file, and the local SQLite store is a rebuildable index of that record.

---

## In scope

- `RecordStore` interface in `src/control-plane/` (sibling of `PromptStore`) with a working-tree JSONL implementation and an in-memory test implementation; the interface must not assume a working-tree path. **The interface and in-memory impl are the first phase** and are frozen before later phases so slice 06 can code against them in parallel.
- Record layout under a configurable `paths.records` root (default `docs/development/runs/<plan-slug>/<run-id>/`): `run.json`, append-only `steps.jsonl`, append-only `decisions.jsonl`; `.gitattributes` `merge=union` for `*.jsonl` under that root, written by `init` / `upgrade`.
- Record writes from the existing primitives: `run init` (create `run.json`), `run record` / `protocol validate --record` / `phase finish` (append step line), `run complete` (seal `run.json`, dedicated seal commit for post-commit steps), answered prompts and `human:*` steps (append decision line).
- `5x commit` stages the records root; `checkGitSafety` exempts uncommitted changes under the records root only.
- Field policy: record `step_name`, `phase`, `iteration`, `result_json`, `head_commit`, `patch_id`, `diff_summary`, `provenance`, `duration_ms`, `tokens_in/out`, `cost_usd`, `model`; never record `session_id`, `log_path`, or transcript content; `records.redact` config drops additional fields. `patch_id` is computed at record time from the previous recorded step's `head_commit` to the current one (`git patch-id --stable`).
- Progress resolution in `plan list` / `plan phases` / `run state --plan`: candidate refs (worktree → local `5x/<slug>` → remote `5x/<slug>` → `plans.branch` → `HEAD`), last-touching-commit per ref, ancestor pruning via `merge-base --is-ancestor`, `diverged` reporting, `source` + ref-age fields in the envelope and text output, `--fetch` and `--all-refs` flags, discovery of branch-only plans.
- `5x records backfill [--plan] [--target auto|<branch>] [--dry-run]` exporting existing DB runs/steps to the record format per `207` §2.7: target-branch rule, `provenance: backfilled` marker, `patch_id` only when computable, idempotent by step key, disagreements reported not overwritten, active runs exported unsealed.
- `5x records index [--plan]` rebuilding `runs` / `steps` from the record without clobbering newer local-only rows; `doctor` `records` check (missing lines, missing rows, unreachable `head_commit`) with `--fix` limited to running the index.
- Skill/template text updates only where the hot loop changes (none expected: composites already wrap the primitives).

---

## Out of scope / deferred

- Any remote control plane, lease service, event stream, or telemetry/blob store (`207` §2.8 records the contract only).
- Git-based coordination (claim files, push-as-CAS) — explicitly rejected in `207` §3.
- `refs/5x/*` ref-namespace storage — reserved option; only the interface seam is required.
- Moving coordination tables (`prompts`, locks, invocation registry, `.5x/current-run`) — they stay local by design.
- Review-budget record fields (`206` §6.4) — slice 06 persists through `RecordStore` but defines its own lines.
- Dashboard reads from git — `04-control-plane-dashboard` reads the index as designed.
- Dropping SQLite.

---

## Primary documents (read in order)

1. `docs/v2/207-state-segmentation.md` — the segmentation rule, record layout, resolution algorithm, reconciliation with other areas.
2. `docs/v2/200-overview.md` §3a — forward-compat constraints (store interface, UUIDs, control plane vs. SQLite) that this slice refines.
3. `docs/v2/202-control-plane.md` §3.1 — store-interface mandate and `src/control-plane/` placement (see `docs/development/plans/205-prompt-queue-foundation-plan.md` for the established layer shape).
4. `docs/v2/203-recovery-and-doctor.md` §2.4 — doctor check registry the `records` check joins.
5. `docs/v2/204-run-context-ergonomics.md` §2.1, §3 — what must remain local and un-synced.
6. `docs/v1/100-architecture.md` §2.3, §3 — idempotent steps and the primitive contract the record writer must not change.
7. Code: `src/commands/plan-v1.handler.ts` (current progress derivation), `src/parsers/plan.ts`, `src/git.ts` (`branchNameFromPlan`, `isBranchRelevant`, `checkGitSafety`), `src/db/schema.ts` (v4/v5 `runs` / `steps`), `src/commands/run-v1.handler.ts` (`run record` write path, `head_commit`).

---

## Dependencies

- [ ] `03-prompt-queue-foundation.plan-input.md` merged — establishes `src/control-plane/` and the store-interface pattern; also provides the answered-prompt event this slice snapshots into `decisions.jsonl`.
- [ ] `02-run-context-ergonomics.plan-input.md` merged (it is) — `phase finish` is the composite that must append records.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Records are committed in the working tree, not a ref namespace (decided; the ref namespace stays a reserved option behind the interface).
- The records root is a sibling of `paths.plans`, not nested under it (decided).
- Squash-merge of `5x/*` branches is the common case; the record must be self-describing via `patch_id` / `diff_summary` without relying on `head_commit` reachability (decided).
- Recording `cost_usd` / `tokens_*` / `model` in-repo is acceptable by default (decided).
- Slice 06 runs in parallel against the frozen `RecordStore` interface and in-memory impl; its persistence never targets SQLite-only rows. If slice 06 needs interface changes after the freeze, they are made here with 06's agreement, not by 06 forking the contract.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 10 phases |
| Must touch areas | `src/control-plane/` (RecordStore), `src/commands/run-v1.handler.ts`, `src/commands/plan-v1.handler.ts`, `src/git.ts`, `src/commands/commit*`, `src/doctor/checks/`, config registry (`paths.records`, `records.redact`), `init` / `upgrade` for `.gitattributes`, tests |
| Forbidden for this slice | No network calls without an explicit `--fetch`; no new coordination semantics; no change to step idempotency keys or existing envelope fields; no direct `bun:sqlite` imports in command logic |

---

## Exit criteria

- On a fresh clone with no `.5x/`, `5x plan list` and `5x plan phases <plan>` show the same progress as the machine that did the work, with `source` naming the ref, given the `5x/<slug>` branch is fetched.
- A run's phase commit contains that phase's `steps.jsonl` lines; `run complete` leaves no uncommitted record files.
- Re-recording an already-recorded step appends no duplicate line and returns the existing step (idempotency preserved).
- Two parallel iterations merged with `merge=union` produce a valid `steps.jsonl` with no conflict markers.
- `5x records index` on a fresh clone materializes `runs` / `steps` rows identical (modulo autoincrement ids and local-only columns) to the origin machine's.
- `doctor` reports records/index drift and `--fix` repairs only by re-indexing.
- Divergent plan branches are reported as `diverged` with all sources, never silently resolved.
- `records backfill --dry-run` on this repository's own `.5x/5x.db` lists every historical run with a target; a real run commits them to the correct branches, a second run is a no-op, and every exported line carries `provenance: backfilled`.
- Agent invocation is not blocked by uncommitted record files; any other dirty state still blocks as before.
- Tests: RecordStore contract (both impls), append/idempotency, commit staging, safety exemption scope, resolution algorithm against a scripted git fixture (merged, stacked, diverged, branch-only, remote-only cases), backfill (target rule, live/deleted branch, partial history across two DBs, disagreement report, dry-run), index rebuild, doctor check, envelope `source` field, redaction.
- Docs: `207` status updated; `docs/v1/101-cli-primitives.md` (or successor) documents `records index`, `--fetch`, `--all-refs`, `source`; config reference gains the new keys.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices — do not implement here):

1. Remote control plane: lease/run-registry/prompt-queue/invocation-registry interfaces with a remote impl, per `207` §2.7 — a new design doc, not a slice of this one.
2. Ref-namespace (`refs/5x/*`) record storage if working-tree noise proves to be a real complaint.
3. Budget-record lines (`206` §6.4) through `RecordStore` — owned by slice 06/07, developed in parallel against the phase-1 interface.
4. `plan.autoFetch` config if teams want implicit fetch.

**Suggested next slice** (optional): `06-review-budget-advisory.plan-input.md` (now persisting through `RecordStore`).

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Records root changes trip `checkGitSafety` and block invocations | Scope the exemption to the configured root by canonical path; test that any other dirty file still blocks |
| `merge-base --is-ancestor` fan-out is slow with many plans × remotes | Batch with `git for-each-ref` + a single `git rev-list` topology query; cache `(ref-sha, path) → result` in the index; measure in a spike phase before optimizing |
| `head_commit` unreachable after squash merges makes records look broken | Treat unreachable as informational; consider adding a patch-id per step in the record schema before freezing it |
| Backfill commits to the wrong branch or double-commits | `--target auto` rule is deterministic and printed by `--dry-run`; idempotency by step key makes reruns no-ops |
| Record writes succeed but the commit never happens (crashed session) | `doctor` `records` check flags uncommitted record files older than the lingering-run threshold; `run complete` seals |
| Slice 06 and slice 10 drift on the `RecordStore` contract while developing in parallel | Freeze the interface + in-memory impl in phase 1, publish it to 06, and treat later changes as a coordinated revision with contract tests both slices run |
