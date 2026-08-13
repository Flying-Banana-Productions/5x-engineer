# Plan input: Recovery and doctor

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-recovery-and-doctor` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

Operators can inspect and safely recover from stale locks and local control-plane inconsistencies through actionable errors and `5x doctor`.

---

## In scope

- Add `5x lock list`, safe `5x unlock <plan>`, and explicit `--force` release with holder details.
- Enrich `PLAN_LOCKED` with holder metadata and exact remediation.
- Add step-budget visibility to `run record`, `run state`, and `MAX_STEPS_EXCEEDED` errors.
- Print structured remediation in text-mode errors without changing JSON envelopes.
- Add a `5x doctor` check registry and standard envelope/text formatting.
- Ship checks and safe `--fix` actions for harness freshness, locks, worktree mappings, lingering runs, and DB health.
- Reuse the area-201 freshness API and preserve `harness.freshnessWarnings = "off"` semantics where applicable.

---

## Out of scope / deferred

- Orphaned-prompt detection and repair; add it in `03-prompt-queue-foundation.plan-input.md` once prompt persistence exists.
- Remote-provider liveness and opaque invocation handles; owned by `05-invocation-registry.plan-input.md`.
- Breaking output normalization; owned by `09-output-normalization-release.plan-input.md`.
- PID-start-time verification, plugin-contributed doctor checks, and configurable warning thresholds unless a plan spike proves they are required.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - v2 shared-core boundaries and compatibility policy.
2. `docs/v2/203-recovery-and-doctor.md` - canonical recovery requirements and acceptance behavior.
3. `docs/v2/201-harness-freshness.md` - implemented freshness states and doctor integration contract.
4. `docs/development/plans/201-harness-freshness-plan.md` - implemented API details available to doctor.
5. `docs/v1/100-architecture.md` - current output/error and persistence contracts being extended.

---

## Dependencies

- [x] Area 201 harness freshness and exported freshness-check seam are implemented.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Warn-only doctor results exit successfully; only failed checks produce a nonzero exit.
- The step warning threshold is fixed at 80% for v2.
- `doctor` and `lock list` remain separate commands.
- Built-in doctor checks are sufficient for this slice; plugin registration is deferred.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 8 phases |
| Must touch areas | `src/lock.ts`, command handlers, output formatting, doctor registry, unit and integration tests |
| Forbidden for this slice | No prompt schema, remote liveness, provider registry, or breaking stdout changes |

---

## Exit criteria

- Lock listing and unlock behavior distinguish live, stale, and corrupt lock files; live locks require explicit `--force`.
- `PLAN_LOCKED` identifies the holder and supplies a usable recovery command.
- Step usage is always visible in `run state` and warns at the documented threshold without suppressing successful records.
- Text errors include remediation on stderr while JSON remains one parseable envelope on stdout.
- `doctor` detects all five in-scope issue classes and fixes only deterministic, non-destructive cases.
- Tests: deterministic unit coverage for checks/fixes plus integration coverage for CLI text, JSON, exit codes, and lock behavior.
- Docs: command references and v2 status reflect the implemented subset and deferred prompt check.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Register a prompt-hygiene doctor check after prompt rows exist.
2. Route future remote liveness through opaque invocation handles rather than extending PID logic.

**Suggested next slice** (optional): `02-run-context-ergonomics.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| `doctor --fix` accidentally removes user-controlled state | Require one unambiguous repair, dry reporting first, and focused filesystem tests |
| Existing output helpers cannot express warnings consistently | Reuse additive envelope fields and custom text formatters; defer breaking cleanup |
| Lingering-run heuristics produce false positives | Report only and avoid automatic status changes |
