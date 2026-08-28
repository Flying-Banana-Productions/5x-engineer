# Review: Invocation Registry — Phase 7 Docs and Final Completion

**Review type:** `9446d189a6d2436945ee88033834e7c8f6c1d83d` (and subsequent commits: none)  
**Scope:** Phase 7 documentation and forward-compatibility notes, plus final production-readiness assessment of all Phase 1–7 implementation commits.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, tests, and exact plan compliance)  
**Local verification:** Focused invocation-registry unit/integration suite — 107 passed; `bun run typecheck` — passed; `bun run lint` — passed; full `bun test --concurrent` — 2,962 passed, 0 failed (106.14s).

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

Phase 7 completes the required documentation and the final implementation is production-ready for the deliberately limited, provider-neutral registry contract. The docs accurately describe capability-driven cancellation, UUID/opaque-handle storage with no PID, metadata-only doctor repair, no `runs.status` mutation, the native-delegation registration gap, the authenticated dashboard seam, and deferred OpenCode-specific cancellation. They explicitly reject revival of the superseded SIGKILL/PID design. The committed Phase 1–6 implementation and its focused/full test evidence support the documented contract.

**Readiness:** Ready — no blocking correctness, architecture, security, performance, operability, test, or plan-compliance issues found.

---

## Plan alignment

| Phase 7 requirement | Evidence |
|---|---|
| Resolve `202` §3.6 location, contents, and opaque-handle TODOs | `docs/v2/202-control-plane.md:123-130` identifies schema-v7 `invocations`, UUID/run/session fields, `{ adapter, ref }`, and no PID/public handle. |
| Capability-driven cancellation and no run-status change | `202:127-129`; `docs/v1/101-cli-primitives.md:506-510` state shipped providers reject unsupported cancellation without adapter/stream/request/run-status side effects. |
| Dashboard seam, not a new server | `202:132-138` documents token-authenticated slice-04 GET/POST wrappers over in-process actions and preserves absent-dashboard scope. |
| Metadata-only doctor repair | `202:129`; `docs/v2/203-recovery-and-doctor.md:10,84` specify predicate-CAS metadata abandonment and explicitly say no provider process is reaped. |
| Seventh doctor check | `203:10,76-92` lists invocations and updates the builtin count from six to seven. |
| Status/cancel CLI contract | `101:446-510` documents explicit identity, id/run intersection, snake_case envelope, unsupported behavior, and terminal no-op semantics. |
| Native-delegation gap | `202:123` clearly states native harness delegations do not enter `invoke.handler.ts` and are not registered in this slice. |
| OpenCode adapter deferral; do not revive superseded design | `202:130`, `101:510`, and `docs/development/plans/011-provider-process-lifecycle.md:6-14` require a new post-v2 plan and prohibit resurrection of PID/SDK/signal/SIGKILL/reaping work. |
| Plan-input pointer | `docs/v2/plan-inputs/05-invocation-registry.plan-input.md:5-14` points to plan 207. |

---

## Strengths

- The documentation distinguishes cancellation capability, request, adapter outcome, and observed terminal state instead of implying a cancellation request killed an invocation.
- The dashboard contract preserves the authorization boundary: token verification occurs before the typed `control-plane` cancellation action.
- The doctor wording is operationally truthful: its repair only changes stale coordination metadata and is guarded against liveness races.
- The final full parallel suite, focused registry suite, typecheck, and lint all pass.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None.

---

## Issue action classification

No issues identified; no `auto_fix`, `human_required`, or follow-up action is required for this completed slice. The intentionally deferred native-delegation registration, dashboard HTTP implementation, and provider-specific/OpenCode cancellation adapter are documented out-of-scope seams, not defects in this plan.

---

## Readiness checklist

**P0 blockers**
- [x] Documentation preserves opaque handles/no PID and capability-driven cancellation.
- [x] Documentation promises neither run-status mutation nor process reaping; doctor repair is metadata-only.
- [x] Native delegation and dashboard boundaries are explicit.
- [x] OpenCode PID/SIGKILL work is deferred to a new plan and the superseded design is not revived.

**P1 recommended**
- [x] Phase 7 completion gate documents `202`, `203`, `101`, `011`, and plan-input changes.
- [x] Focused and full tests, typecheck, and lint pass.
