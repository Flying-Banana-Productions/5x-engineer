# Plan input: Interactive control-plane dashboard

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-control-plane-dashboard` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

An authenticated local dashboard can observe runs, receive pending prompts live, answer them atomically, and invoke approved existing run-control primitives.

---

## In scope

- Add the `5x dashboard` command and local Bun HTTP/WebSocket server.
- Implement authenticated static, HTTP API, and WebSocket access using per-process tokens and HttpOnly cookies.
- Reuse the useful read-model, telemetry, log-streaming, and presentation requirements from the deprecated dashboard design against the current v1 schema.
- Push open/answered prompt changes to connected clients and expose an answer endpoint through the prompt repository CAS operation.
- Map abort, reopen, human record, and quality rerun actions to existing in-process handlers with the same validation, records, and envelopes as CLI calls.
- Version WebSocket/API messages and handle stale clients safely.
- Resolve managed and isolated control-plane roots consistently from any checkout.
- Deliver a functional responsive operator UI for run overview/detail, logs, pending prompts, and supported actions.

---

## Out of scope / deferred

- Agent cancellation; owned by `05-invocation-registry.plan-input.md`.
- Multi-user authorization, multi-repo aggregation, cloud sync, and remote stores.
- New orchestration mutations where an existing idempotent primitive already exists.
- Budget visualization and budget-specific decisions; added by `07-plan-review-governance.plan-input.md` after their contracts exist.
- Treating `.5x/current-run` as authoritative shared state.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - control-plane thesis and forward-compatibility constraints.
2. `docs/v2/202-control-plane.md` - canonical interactive architecture and allowed write paths.
3. `docs/10-dashboard.md` - presentation, telemetry, transport, auth, and read-path reference only; its read-only architecture is superseded.
4. `docs/v1/101-cli-primitives.md` - existing run-control commands the server must reuse.
5. `docs/v1/100-architecture.md` - persistence, logging, and command-handler invariants.

---

## Dependencies

- [ ] `03-prompt-queue-foundation.plan-input.md` is merged with tested repository and CAS semantics.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- HTTP write endpoints call handlers in-process rather than spawning the CLI.
- One high-entropy local token is sufficient for v2; non-loopback binding remains explicit and authenticated.
- The dashboard read path can be adapted from `docs/10-dashboard.md` without preserving its obsolete schema assumptions.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 12 phases |
| Must touch areas | Dashboard command/server, repository-backed write APIs, read model, WebSocket protocol, static client, auth and integration tests |
| Forbidden for this slice | No direct dashboard DB mutation, provider PID handling, cloud synchronization, or bespoke replacements for existing handlers |

---

## Exit criteria

- `5x dashboard` serves a responsive authenticated UI and shuts down cleanly.
- Unauthorized HTTP and WebSocket clients cannot read project data or perform actions.
- Pending prompts appear without page refresh and browser answers participate in first-writer-wins CAS races with terminal answers.
- Every supported control action produces the same durable state transition as its CLI primitive.
- Run/plan/log views tolerate malformed or missing historical data without crashing the server.
- Tests: server auth, API validation, WebSocket protocol, CAS races, handler parity, control-plane-root resolution, and browser smoke coverage.
- Docs: `docs/10-dashboard.md` remains clearly presentation-only and the new v2 command/API contract is documented.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Add cancellable invocation actions only after opaque registry semantics exist.
2. Add budget panels and specific tradeoff actions after advisory budget records are stable.

**Suggested next slice** (optional): `05-invocation-registry.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Deprecated dashboard design references obsolete tables | Reconcile every read query against current schema before implementation |
| HTTP paths bypass CLI validation or produce different records | Call exported handlers and add parity tests around resulting DB state |
| Non-loopback binding exposes logs and source context | Require token auth everywhere, restrictive token-file permissions, and explicit host opt-in |
