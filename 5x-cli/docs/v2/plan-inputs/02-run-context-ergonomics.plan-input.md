# Plan input: Run-context ergonomics

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-run-context-ergonomics` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

Run-scoped commands reliably infer run identity from explicit, environment, or workspace context and expose one safe post-author composite.

---

## In scope

- Implement strict run resolution precedence: `--run`, `FIVEX_RUN`, `.5x/current-run`, then actionable error.
- Write the active-run file on run initialization and clear it conditionally on completion.
- Apply the resolver consistently to all run-scoped commands and mark the active run in `run list`.
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

- `.5x/current-run` is the final v2 storage choice because it is local, inspectable, and migration-free.
- Phase and iteration remain explicit.
- A composite propagates the failing sub-step's exit code rather than defining a new code.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 8 phases |
| Must touch areas | Run-context resolver, run lifecycle, phase command adapter/handler, pipe warning, bundled skills |
| Forbidden for this slice | No phase inference, session inference, prompt store, dashboard selection, or new orchestration semantics |

---

## Exit criteria

- Every documented run-scoped command follows identical precedence and explicit `--run` remains behaviorally unchanged.
- Concurrent sessions can pin separate runs with `FIVEX_RUN` despite changes to `.5x/current-run`.
- Completing one run cannot clear a pointer that now references another run.
- `phase finish` reports completed, failed, and skipped sub-steps and resumes safely after partial completion.
- An expired implicit pipe-context read is visible on stderr and never corrupts stdout JSON.
- Tests: unit coverage for precedence/pointer races and composite resumption; integration coverage for representative run-scoped commands and CLI output.
- Docs/skills: bundled skills use the new idiom and preserve granular fallbacks.

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
| Shared pointer selects the wrong concurrent run | Keep `FIVEX_RUN` above the file and teach skills to export it immediately |
| Composite duplicates existing semantics | Compose existing handlers and assert identical step/idempotency records |
| Skill refresh conflicts with harness manifests | Regenerate through supported harness sync/install paths and verify freshness |
