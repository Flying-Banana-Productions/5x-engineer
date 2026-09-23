# Plan input: Plan-review governance dashboard follow-up

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-plan-review-governance-dashboard` |
| **Status** | `blocked` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-09-22 |

## One-line goal

Expose the implemented plan-review forecast, gate, and immutable decision
contracts through the authenticated dashboard after slice 04 merges.

## Prerequisites

- [x] `07-plan-review-governance.plan-input.md` supplies durable records,
  rebuildable indexes, typed prompt metadata, and handler-safe read/action seams.
- [ ] `04-control-plane-dashboard.plan-input.md` supplies authenticated HTTP/
  WebSocket transport and its action authorization boundary.

## In scope

- Forecast views for `B0`, governing `B`, `W`, `R`, `E`, `A`, gross positive
  architecture burden, budget band, alerts, and debt evidence. Debt credit must
  never hide gross effort, absolute ceilings, or positive burden.
- Active-gate views using the redacted `ReviewGatePromptContext`, including
  stable gate/snapshot IDs, causes, eligible finding ID/fingerprint pairs,
  `allowedChoices`, and `requiredFieldsByChoice`.
- Full immutable decision/audit history, including stale, malformed, and
  superseded diagnostics rather than an empty-ledger fallback.
- Authenticated decisions that call exported `showPlanReviewGate` and
  `submitPlanReviewDecision`; no dashboard-specific decision arithmetic or CAS.
- Live refresh after reviewer records, gate decisions, prompt repair, restart,
  and `records index` rebuild.
- Adapter parity tests proving dashboard and CLI submissions produce identical
  decision payloads, routes, terminal abort records, and structured errors.

## Out of scope

- Changing the governance policy, arithmetic, finding fingerprints, or choice
  validation implemented by plan 209.
- Generic `answerPrompt` for plan-review gates; those rows are notifications and
  must continue returning `REVIEW_GATE_DECISION_REQUIRED`.
- Implementation-review governance and realized debt reconciliation (slice 08).
- Promoting advisory baselines in place or changing advisory as the default.

## Required seams from plan 209

- Public actions: `showPlanReviewGate`, `submitPlanReviewDecision`.
- Public DTOs: `ReviewGatePromptContext`, `RedactedPromptView`, governance
  decision/gate structural types, and `toRedactedPromptView`.
- Authoritative records: `budget.jsonl`, `decisions.jsonl`, and steps-order
  acceptance classification; SQLite is only the rebuildable dashboard index.
- CLI discovery/input syntax remains canonical: ID-only `--finding` resolves the
  fingerprint, while machine JSON/stdin supplies and validates identity pairs.

## Exit criteria

- Unauthorized requests never call an action handler.
- Concurrent CLI/dashboard choices converge on one RecordStore gate-key winner.
- Restart and index rebuild reproduce forecast, active gate, governing state,
  decision ordering, and malformed/stale diagnostics.
- Browser, HTTP, WebSocket, and adapter parity tests cover every governance
  choice and structured error without duplicating the choice/cause matrix.
