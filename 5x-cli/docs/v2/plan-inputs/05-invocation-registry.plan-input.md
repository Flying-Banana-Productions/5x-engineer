# Plan input: Provider-neutral invocation registry

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-invocation-registry` |
| **Status** | `planned` |
| **Owner** | |
| **Generated plan** | `docs/development/plans/207-invocation-registry-plan.md` |
| **Last updated** | 2026-08-28 |

---

## One-line goal

The control plane tracks active agent invocations through opaque provider-neutral handles and exposes truthful cancellation capability without embedding local PID assumptions.

---

## In scope

- Define invocation identity, lifecycle states, ownership, timestamps, session/run linkage, capability metadata, and terminal outcomes.
- Define an opaque cancellation-handle/provider-adapter contract that can represent local or remote invocations.
- Add an invocation registry behind a store interface, including stale-entry inspection and deterministic cleanup rules.
- Register/unregister invocations around provider execution without changing provider-specific process ownership.
- Expose invocation status and cancellation capability to the control-plane server and dashboard.
- Add an authenticated cancellation action that invokes the adapter only when supported and records requested/succeeded/failed outcomes.
- Add doctor reporting for abandoned registry entries without claiming that all underlying processes can be reaped.

---

## Out of scope / deferred

- OpenCode SDK patches, child-PID extraction, SIGTERM/SIGKILL policy, process-group behavior, or OpenCode orphan reaping.
- Provider-specific cancellation implementations that require unresolved platform integration.
- A daemon, supervisor, or guarantee of cancellation for providers that expose no cancellable handle.
- SIGKILL/OOM orphan prevention.
- Automatic run abortion when an invocation is cancelled unless a separate workflow requirement defines it.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - opaque-handle and control-plane forward-compatibility constraints.
2. `docs/v2/202-control-plane.md` - phase-2 cancellation registry intent and server boundary.
3. `docs/v1/100-architecture.md` - current `AgentProvider`/`AgentSession` ownership model.
4. `docs/development/plans/011-provider-process-lifecycle.md` - superseded historical failure analysis only; do not inherit its OpenCode-specific design.

---

## Dependencies

- [ ] `04-control-plane-dashboard.plan-input.md` is merged with authenticated action and live-status infrastructure.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- The initial v2 foundation may report `cancellationSupported: false` for providers without an adapter.
- Durable registry metadata contains opaque references and capabilities, not necessarily a local PID.
- Registration wrappers can be added without redesigning the provider interface used for normal invocation.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 8 phases |
| Must touch areas | Provider-neutral lifecycle contract, registry store, invoke integration, dashboard/API status, doctor reporting |
| Forbidden for this slice | No OpenCode SDK patch, PID scraping, forced process kill, provider daemon, or false cancellation guarantees |

---

## Exit criteria

- Every invocation gets a globally unique registry identity and reaches a defined terminal or abandoned state.
- The registry does not expose local PID fields as its universal contract.
- Unsupported providers report cancellation as unavailable and reject requests without changing run status.
- A test adapter proves a supported opaque handle can receive exactly one idempotent cancellation request and record its outcome.
- Dashboard/API clients can distinguish running, cancellation-requested, cancelled, completed, failed, abandoned, and unsupported states as designed.
- Doctor can identify stale registry metadata and applies only safe metadata cleanup.
- Tests: lifecycle transitions, idempotency, crash/stale metadata, auth, unsupported adapters, and a synthetic cancellable adapter.
- Docs: OpenCode-specific cancellation is explicitly deferred to a new post-v2 plan.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Investigate each provider's concrete cancellation primitive against the stable adapter contract.
2. Create a fresh OpenCode plan for process cleanup, PID/SDK constraints, escalation, and orphan reaping if still needed.

**Suggested next slice** (optional): `06-review-budget-advisory.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| A generic handle contract accidentally assumes local processes | Require an opaque adapter-owned reference and test with a non-PID synthetic remote handle |
| Registry state implies cancellation succeeded when only requested | Model request, adapter result, and terminal observation separately |
| Provider wrappers leak resources on errors | Use one lifecycle boundary with `try/finally` and focused fault-injection tests, without prescribing provider cleanup internals |
