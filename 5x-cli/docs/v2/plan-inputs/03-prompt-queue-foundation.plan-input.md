# Plan input: Prompt-queue foundation

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-prompt-queue-foundation` |
| **Status** | `planned` |
| **Owner** | |
| **Generated plan** | `docs/development/plans/205-prompt-queue-foundation-plan.md` |
| **Last updated** | 2026-08-25 |

---

## One-line goal

Human prompts are durable UUID-addressed control-plane records that terminal and future remote writers answer atomically through one store interface.

---

## In scope

- Define the minimal control-plane prompt repository independent of SQLite command logic.
- Add UUID-keyed prompt persistence, open/recent indices, migration, row types, and SQLite repository implementation.
- Implement create, read, list-open, and compare-and-swap answer operations with first-writer-wins semantics.
- Change `5x prompt choose`, `confirm`, and `input` to create a pending row and use the repository for terminal/default answers.
- Preserve immediate non-interactive `--default` behavior and existing successful result envelopes.
- Define bounded polling, timeout, terminal/dashboard race, losing-writer, interruption, and terminal-run cleanup behavior.
- Add the orphaned-prompt doctor check deferred from slice 1, including deterministic abandonment repair for prompts whose run is terminal.

---

## Out of scope / deferred

- HTTP, WebSocket, browser UI, authentication, or dashboard answer endpoints; owned by `04-control-plane-dashboard.plan-input.md`.
- General-purpose decisions table unless a planning spike proves answered prompts plus `human:*` steps cannot represent required behavior.
- Review-budget records and decisions; begin in `06-review-budget-advisory.plan-input.md`.
- Remote/synchronized store implementation; only preserve the abstraction and CAS contract.
- Agent cancellation or provider lifecycle handling.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - run-state surface and forward-compatibility constraints.
2. `docs/v2/202-control-plane.md` - decision-queue inversion, repository, schema, and polling semantics.
3. `docs/v2/203-recovery-and-doctor.md` - orphaned-prompt diagnostic and repair requirement.
4. `docs/v1/101-cli-primitives.md` - current prompt UX and non-interactive contract.
5. `docs/v1/100-architecture.md` - persistence, output, and source-of-truth invariants.

---

## Dependencies

- [ ] `01-recovery-and-doctor.plan-input.md` should be merged before registering its deferred prompt check.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Answered prompts are sufficient for request/answer history; unsolicited decisions continue to use `human:*` steps.
- No-TTY plus `--default` resolves immediately through the same CAS operation.
- Existing run IDs are already globally unique enough; every new prompt ID must be a UUID.
- SQLite is the sole v2 store implementation, but command logic depends on the repository contract.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 10 phases |
| Must touch areas | DB migration/operations, control-plane store interface, prompt handlers, doctor registry, concurrency tests |
| Forbidden for this slice | No dashboard server, browser UI, budget schema, provider cancellation, or direct SQLite access from prompt command logic |

---

## Exit criteria

- Prompt commands persist an open prompt before waiting for any interactive answer.
- Terminal/default writers and test control-plane writers use one atomic CAS operation; exactly one answer wins.
- The losing writer receives the stored winning answer without overwriting it.
- Non-interactive defaults preserve existing CI behavior and no-answer cases terminate according to a documented timeout/error contract.
- Repository tests run against SQLite and a test implementation without changing command behavior.
- Doctor reports and safely resolves prompt rows orphaned by terminal runs.
- Tests: migration, repository contract, CAS race, timeout/interruption, terminal/default behavior, and CLI compatibility coverage.
- Docs: prompt contract shift and repository semantics are documented.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Expose open prompts and CAS answers through the authenticated control-plane server.
2. Extend the repository family for durable budget and human-decision state without leaking SQLite into workflows.

**Suggested next slice** (optional): `04-control-plane-dashboard.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| TTY input cannot be cancelled when a dashboard answer wins | Spike cancellable terminal reads before finalizing the poll/input coordination |
| CAS behavior differs across store implementations | Specify repository-level race tests and make SQLite update conditional on unanswered state |
| Prompt process interruption leaves permanent open rows | Define abandonment lifecycle and doctor cleanup before command integration |
