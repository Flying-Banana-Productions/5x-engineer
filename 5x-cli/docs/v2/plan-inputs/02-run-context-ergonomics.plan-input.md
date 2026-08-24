# Plan input: Run-context ergonomics

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-run-context-ergonomics` |
| **Status** | `planned` |
| **Owner** | |
| **Generated plan** | `docs/development/plans/204-run-context-ergonomics-plan.md` |
| **Last updated** | 2026-08-24 |

---

## One-line goal

Run-scoped commands safely resolve operator context from explicit, session, linked-worktree, or local-focus signals while queued invocations retain explicit run identity, and expose one safe post-author composite.

---

## In scope

- Implement strict run resolution precedence: `--run`, `FIVEX_RUN`, unique active run mapped to the current linked worktree, compatible `.5x/current-run`, then actionable error.
- Infer linked-worktree context from existing canonical `plans.worktree_path` mappings without adding a per-worktree pointer registry.
- Reject ambiguous worktree associations and prevent the shared pointer from implicitly selecting a run mapped to another linked worktree.
- Write the control-plane-local focus file on run initialization and clear it conditionally on completion.
- Apply the resolver consistently to all run-scoped commands and mark the ambiently resolved run and source in `run list`.
- Add `5x phase finish` as fail-forward sugar over existing quality, author protocol, checklist, and record handlers.
- Preserve granular command semantics and idempotency keys when the composite is retried.
- Warn when implicit piped context times out instead of silently dropping it.
- Update bundled workflow skills to export `FIVEX_RUN`, use `phase finish`, and retain granular recovery instructions.

---

## Out of scope / deferred

- Inferring `--phase`, `--iteration`, or `--session` from ambient state.
- `5x phase start`; reconsider only after measuring remaining command/plumbing overhead.
- Removing implicit pipe-context support.
- Treating the active-run pointer as synchronized control-plane state or a dashboard authority.
- Adding per-worktree active-run pointer storage or a workspace-focus database table.
- Using ambient run resolution for prompt-queue workers or invocation-registry dispatch; queued work carries explicit run identity.
- Generalizing worktrees into a container, VM, or remote execution-target registry.
- Breaking output changes; owned by `09-output-normalization-release.plan-input.md`.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - shared run-state intent and local-pointer boundary.
2. `docs/v2/204-run-context-ergonomics.md` - canonical resolution and composite design.
3. `docs/v1/100-architecture.md` - idempotent primitive and session-continuity invariants.
4. `docs/v1/101-cli-primitives.md` - current run, quality, protocol, and template command contracts.

---

## Dependencies

- [ ] No unimplemented v2 slice is blocking; this may run in parallel with recovery work.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- `.5x/current-run` remains the final v2 focus storage choice because it is local, inspectable, and migration-free; worktree isolation comes from inference, not pointer keying.
- Existing plan-to-worktree mappings are sufficient to identify the unique active run for a linked checkout; if reality violates uniqueness, resolution fails rather than guessing.
- Phase and iteration remain explicit.
- A composite propagates the failing sub-step's exit code rather than defining a new code.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 8 phases |
| Must touch areas | Run-identity/worktree resolver, run lifecycle, phase command adapter/handler, pipe warning, bundled skills |
| Forbidden for this slice | No per-worktree pointer registry, execution-target registry, phase inference, session inference, prompt store, dashboard selection, or new orchestration semantics |

---

## Exit criteria

- Every documented run-scoped command follows identical precedence and explicit `--run` remains behaviorally unchanged.
- Two linked or externally attached worktrees sharing one control-plane DB can each resolve their own uniquely mapped active run without `--run`, `FIVEX_RUN`, or pointer coordination.
- A shared pointer never causes an implicit command from one linked worktree to select a run mapped to another worktree.
- Multiple active runs mapped to one worktree fail with an ambiguity error that lists candidates and remediation.
- Concurrent sessions in one checkout can pin separate runs with `FIVEX_RUN` despite changes to `.5x/current-run`.
- Completing one run cannot clear a pointer that now references another run.
- `phase finish` reports completed, failed, and skipped sub-steps and resumes safely after partial completion.
- An expired implicit pipe-context read is visible on stderr and never corrupts stdout JSON.
- Tests: unit coverage for precedence, canonical worktree matching, ambiguity, pointer compatibility/races, and composite resumption; integration coverage from two linked/external worktrees for representative run-scoped commands and CLI output.
- Docs/skills: bundled skills use the new idiom and preserve granular fallbacks.
- Forward-compatibility docs state that invocation workers receive explicit `run_id`; ambient worktree/pointer resolution is never a dispatch or ownership mechanism.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Let the dashboard optionally read the local pointer only as an initial view hint.
2. Measure whether `phase start` has enough remaining value for a future slice.

**Suggested next slice** (optional): `03-prompt-queue-foundation.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Shared pointer selects a run mapped to another linked worktree | Resolve a unique canonical worktree association before the pointer and reject incompatible pointer fallback |
| Multiple plans map active runs to one worktree | Fail with candidates and require explicit `--run` or `FIVEX_RUN`; never guess |
| Symlinks or external worktree paths defeat matching | Compare canonical physical checkout identity, including nested invocation directories |
| Same-checkout sessions need different runs | Keep `FIVEX_RUN` above filesystem context and teach skills to export it immediately |
| Composite duplicates existing semantics | Compose existing handlers and assert identical step/idempotency records |
| Skill refresh conflicts with harness manifests | Regenerate through supported harness sync/install paths and verify freshness |
