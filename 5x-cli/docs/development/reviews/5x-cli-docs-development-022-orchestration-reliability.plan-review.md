# Review: Orchestration Reliability Improvements

**Review type:** `docs/development/022-orchestration-reliability.plan.md`
**Scope:** Plan review for review-path warnings, session continuity, protocol emit, and checklist-gate fixes
**Reviewer:** Staff engineer
**Local verification:** Source review only; no tests run

## Summary

The plan addresses real reliability gaps and mostly fits the current architecture, but it is not ready as written. Two design decisions create blocking rollout risk: the new reviewer session-enforcement default is broader than the available template set, and the proposed `5x protocol emit` contract conflicts with the CLI's existing success-envelope convention.

**Readiness:** Not ready - blocking contract and rollout issues need human decisions before implementation.

## Strengths

- Anchors each problem in an observed failure mode and generally reuses existing architecture instead of adding parallel systems.
- Breaks the work into clear phases with concrete file targets and a credible unit/integration test plan.

## Production Readiness Blockers

### P0.1 - Reviewer session enforcement defaults are broader than template coverage

**Risk:** New projects will enable `reviewer.continuePhaseSessions = true`, but implementation-review flows already reuse reviewer sessions through `reviewer-commit` and there is no `reviewer-commit-continued` template. That means a normal second review in phase execution can fail by design with `TEMPLATE_NOT_FOUND`.

**Action:** `human_required`

**Requirement:** Narrow enforcement/defaults to only the plan-review path, or add the missing continued implementation-review template(s) and update the implementation-review skill in the same change. Do not ship a scaffold default that knowingly breaks an existing review loop.

### P0.2 - `5x protocol emit` output contract is inconsistent with the structured-result contract

**Risk:** The plan says agents should call `5x protocol emit ...` and include that command's JSON output as their structured result, but the implementation section also says the command should return via `outputSuccess()`, which wraps data in `{ ok, data }`. That envelope is not the canonical reviewer/author schema expected by provider structured-output validation, so the main `5x invoke` path can still fail.

**Action:** `human_required`

**Requirement:** Pick one end-to-end contract and document it precisely: either `protocol emit` writes raw canonical JSON to stdout, or templates/callers must explicitly unwrap `.data` before returning. Align `emit`, `invoke`, native-subagent guidance, and validation behavior to the same contract.

## High Priority (P1)

### P1.1 - Continued-template existence check is ordered incorrectly for `--new-session`

The session-validation algorithm says that when prior steps exist it should first require `<template>-continued` to exist, then check whether the caller passed `--session` or `--new-session`. That makes `--new-session` fail for templates without a continued variant even though `--new-session` explicitly requests the full template path. This contradicts the design goal that `--new-session` is the recovery escape hatch.

**Action:** `auto_fix`

**Recommendation:** Only require the continued template when the caller is actually resuming (`--session`) or when the tool is forcing the user to choose between resuming and starting fresh. If `--new-session` is set, skip the continued-template requirement.

### P1.2 - Reviewer normalization defaults are too permissive for a safety path

Defaulting missing reviewer `action` to `auto_fix` is not conservative. The current reviewer instructions explicitly say ambiguous items should lean `human_required`; this normalization would silently flip missing/partial output into the least-safe automation path.

**Action:** `human_required`

**Recommendation:** Either keep missing `action` as a validation failure, or default it to `human_required`. Treat this as a policy decision, not a mechanical normalization detail.

## Medium Priority (P2)

- The plan says the phases are independent, but Phase 3 materially changes template instructions and protocol-validation behavior together. Tighten that dependency note so implementation order and rollback expectations stay explicit.

## Readiness Checklist

**P0 blockers**
- [ ] Resolve rollout scope for reviewer session enforcement versus missing continued implementation-review templates.
- [ ] Define a single `protocol emit` stdout contract that matches provider and validator expectations.

**P1 recommended**
- [ ] Reorder session-validation logic so `--new-session` remains a real recovery path.
- [ ] Change reviewer normalization so missing `action` does not silently become `auto_fix`.

## Addendum (2026-03-17) - Review Round 2

### What's Addressed

- The session-enforcement rollout risk is addressed: the default stays `false`, the scaffold only documents opt-in, and the plan now explicitly calls out `reviewer-commit-continued` as a prerequisite before enabling reviewer enforcement broadly.
- The `5x protocol emit` contract is now clear on the success path: it writes raw canonical JSON to stdout and the template instructions tell agents to return that output verbatim.
- The `--new-session` logic is reordered correctly so it bypasses continued-template checks and remains a real recovery path.
- Reviewer normalization now defaults missing `action` to `human_required`, which matches the safety posture described in the templates.
- The Phase 3 dependency note is improved and now correctly treats template and protocol changes as an atomic rollout unit.

### Remaining Concerns

- **P1 / `auto_fix`**: Phase 3 still has an internal inconsistency on the error path for `5x protocol emit`. The handler section says failures still use `outputError()`, but the planned integration tests say to verify stderr/exit code and "not stdout envelope." In the current CLI architecture, `outputError()` writes a JSON error envelope to stdout. The plan should pick one error-path contract and align the handler text and tests to it.
