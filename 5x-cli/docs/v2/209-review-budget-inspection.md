# 5x CLI v2 — Review Budget Inspection

**Status:** Draft — Not Implemented
**Date:** September 23, 2026
**Related:** [206-review-budget-governance.md](206-review-budget-governance.md) (budget model), [205-output-normalization.md](205-output-normalization.md) (output contract), [207-state-segmentation.md](207-state-segmentation.md) (durable records and derived state)
**Builds on:** Existing review-budget records, governance decisions, `5x run state`, and `5x review gate show`
**Breaking:** No — additive read-only commands

---

## 1. Problem

The CLI exposes a compact current-budget summary through `5x run state --text` and gate details through `5x review gate show --text`. JSON run state exposes additional aggregates, but neither command explains the full work-item ledger or its evolution across reviews.

The underlying records contain more useful information: the original baseline, current ledger at each review, independent reviewer estimate, finding deltas, credit assessments, governance outcomes, and human decisions. Today an operator must inspect `budget.jsonl` and related records manually to reconstruct that story.

The missing interface should answer three questions:

1. **What is the budget?** Show the applicable baseline, forecast, ceilings, architecture burden, and policy mode.
2. **Why is it that number?** Show work items, outstanding findings, debt claims, and the evidence behind them.
3. **What changed during review?** Show ledger changes, finding disposition, alerts, and human decisions in order.

An advisory architecture alert may remain present after a run legitimately completes. Inspection must distinguish an advisory prediction from an enforced, actionable gate instead of making the completed run look blocked.

## 2. Goals and boundaries

- Provide useful terminal output without requiring knowledge of internal budget abbreviations or JSON record shapes.
- Provide stable structured output suitable for scripts and other interfaces.
- Explain recorded history faithfully, including the policy and decisions applicable at the selected point.
- Reuse canonical budget arithmetic and governance state resolution; do not introduce a second budgeting engine.
- Support active, completed, and archived runs through existing run/record resolution.
- Keep inspection genuinely read-only and bounded for long histories.

The first release does not include a TUI, charts, live rescoring of an edited plan, arbitrary snapshot-to-snapshot comparison, export formats, or governance mutations. Complexity points remain coarse estimates, not elapsed time, money, or measured engineering effort.

## 3. Command surface

Place the commands under the existing `review` family:

```sh
5x review budget show --run <id> --text
5x review budget show --run <id> --json
5x review budget show --run <id> --snapshot <snapshot-id> --text

5x review budget history --run <id> --text
5x review budget history --run <id> --json
5x review budget history --run <id> --limit 20 --before <event-id> --text
```

Omitting `--run` uses existing ambient run resolution. These commands follow the normal global output-format precedence: JSON by default, explicit `--text` or `--json`, and the existing environment default. They are not streaming-output exceptions.

### 3.1 `review budget show`

| Option | Behavior |
|---|---|
| `--run <id>` | Select a run; otherwise resolve ambient identity. |
| `--snapshot <id>` | Select an exact recorded review snapshot by durable ID. Without it, inspect the latest recorded state. |
| `--verbose` | Expand evidence and rationale in text output. JSON remains complete regardless of this flag. |

Default inspection uses the latest snapshot and any subsequent effective governance decisions. Display the snapshot identity separately from the state’s effective-through event, so a decision after the last review is visible rather than silently attributed to that review.

Explicit snapshot inspection shows the state **at that snapshot**, including only decisions effective by that point. A later budget increase must not retroactively change an earlier review’s ceiling, route, or displayed baseline.

Always show the original baseline alongside the applicable governing baseline. If baseline capture exists but no review snapshot does, return a baseline-only view with “No review snapshots yet.” If no baseline exists, return a clear not-initialized/off/legacy-compatible state as supported by existing resolution; do not capture a baseline. An explicitly requested missing snapshot is a not-found error, not a fallback to the latest one.

### 3.2 `review budget history`

History is a chronological explanation of governance activity, not a raw dump of one storage stream. Include:

- Baseline capture.
- Recorded review snapshots.
- Durable governance decisions affecting budget, scope, accepted risk, architecture approvals, or disposition.

Decision entries may originate outside `budget.jsonl`; resolve them through the existing record-backed governance interfaces. Include stable event IDs, timestamps, and links to associated snapshot/gate/finding identities where available.

Return the latest 20 events by default, displayed oldest-to-newest within the page. `--limit` must be a positive bounded integer; an initial maximum of 100 is sufficient. `--before <event-id>` selects the preceding page, excluding that event. Unknown or foreign-run cursors fail explicitly. Return a cursor for the next older page; do not require users to infer it from timestamps.

Use canonical persisted ordering and causal links, with stable tie-breaking where needed. Do not sort solely by timestamp or invent an order that places a decision before its referenced snapshot. Pagination must remain stable when newer records are appended.

## 4. Human-readable presentation

### 4.1 Budget detail

The default `show --text` output is an explanation, not a generic nested-object renderer. Illustrative output:

```text
Review budget · run_example
Plan: 5x-cli/docs/development/plans/213-run-watch-tui-plan.md
Snapshot: <snapshot-id> · review 2 · closure
Mode: advisory (pinned)
Recorded outcome: ready → complete

EFFORT
Original baseline        28
Governing baseline       28
Reviewer estimate        32
Current planned work     28
Outstanding corrections   0
Projected effort         28
Effective ceiling        35
Absolute ceiling         42
Assessment               Within standard budget

ARCHITECTURE
Positive burden           9
Policy threshold          7
Eligible debt credit      0
Alert                     Positive architecture threshold exceeded

Advisory only: enforcement would require a human decision.
This alert did not block completion.

WORK ITEMS
ID  Work item                         Effort  Arch  Addresses
W1  Terminal adapter                       5    +1  P1.2, P2.1
W2  Provider metadata                      3    +2  P1.1
W3  Replay-aware tailing                    5    +1  P1.3
...

FINDINGS
P1.1  Resumed-session workspace       Addressed
P1.2  Signal cleanup                 Addressed
P1.3  Legacy replay ordering          Addressed
P1.4  Resize-safe paused state        Addressed
P2.1  Compiled smoke-test entry       Addressed

Change since previous review:
  Outstanding correction effort: 4 → 0
  Planned work:                  28 → 28
  Projected effort:              32 → 28
  Five findings closed; architecture alert unchanged.
```

Use descriptive labels instead of making operators memorize `B`, `W`, `R`, and `E`. Keep those established symbols in structured output. Show the standard ceiling separately when it differs from the effective ceiling, and explain approved exceptions or applicable credits rather than collapsing them into an unexplained number.

Work items are part of the default view. Their stable IDs, effort, signed architecture deltas, and `Addresses` associations explain the aggregates. Finding rows include carried-forward titles and dispositions even when the latest reviewer’s `items[]` is empty. Show pending effort and architecture deltas for outstanding findings.

The default view includes a compact debt-claim/credit summary when claims exist. Distinguish claimed reduction, eligible reduction, and allowed credit; do not imply that negative architecture cancels gross effort. Distinguish provisional credit from realized credit only when the underlying records support that status.

With `--verbose`, expand work-item score rationales; finding failure and lowest-cost-correction evidence; debt-claim before/after and minimal-alternative evidence; reviewer credit assessments; and applicable decision rationale. Missing historical evidence is labeled unavailable, never reconstructed from the current plan.

Wrap text to terminal width, preserve stable IDs, and render recorded content as safe text. Color is optional reinforcement; labels must remain meaningful in plain output. Do not silently omit rows: any presentation truncation must be explicit, with a way to see the complete content through verbose text or JSON.

### 4.2 History

Illustrative `history --text` output:

```text
Review budget history · run_example
Pinned mode: advisory

Event       Baseline  Work  Remaining  Projected  Ceiling  Arch  Outcome
Baseline          28    28          —         28       35     9  Captured
Review 1          28    28          4         32       35     9  Author revision
Review 2          28    28          0         28       35     9  Complete

Review 1 · <snapshot-id>
  Opened P1.1–P1.4 and P2.1.
  Architecture alert: 9 > 7.
  Enforced policy would have required a human decision.

Review 2 · <snapshot-id>
  Addressed all five findings.
  No work-item score changes.
  Architecture alert remained advisory.
```

Decision events appear between the reviews they affect, for example:

```text
Decision · <decision-id>
  Choice: increase_budget
  Governing baseline: 28 → 32
  Rationale: ...
```

Every review entry exposes its snapshot ID for `show --snapshot`. History differences are computed against the preceding relevant recorded state, even when that predecessor falls outside the displayed page. Explain that predecessor or identify it in JSON so page boundaries do not alter the meaning of a delta.

## 5. Structured output

### 5.1 Shared inspection model

Use the existing `{ ok, data }` / `{ ok, error }` envelope. The following is a proposed outer shape, not a new definition of the existing budget arithmetic types:

```json
{
  "ok": true,
  "data": {
    "run_id": "run_example",
    "plan_path": "...",
    "run_status": "completed",
    "budget_status": "active",
    "selection": {
      "kind": "latest",
      "snapshot_id": "...",
      "effective_through_event_id": "..."
    },
    "baseline": {},
    "snapshot": {},
    "budget": {},
    "governance": {},
    "work_items": [],
    "findings": [],
    "debt_claims": [],
    "decisions": [],
    "changes_since_previous": {},
    "completeness": { "complete": true },
    "diagnostics": []
  }
}
```

Reuse existing nested budget/governance contracts wherever possible; settle exact exported types against those contracts during implementation. In particular:

- `budget` retains established aggregate names such as `B0`, `B`, `I`, `W`, `R`, `projectedEffort`, `E`, and `P`, including applicable thresholds, bands, and alerts.
- `baseline` contains original ledger, pinned mode/configuration, confidence, capture identity/time, and available provenance. Governing changes are represented separately through the canonical state and decisions.
- `snapshot` identifies the selected review, its step/iteration, timestamp, and available commit provenance.
- `governance` distinguishes the recorded review route, effective route after decisions, hypothetical enforced route, and actionable gate. Historical gates must not be represented as currently actionable.
- `findings` is the finding register at the selected point, including addressed and accepted-risk/deferred states where supported. Preserve stable IDs/fingerprints, assessments, evidence, and plan associations.
- `debt_claims` includes recorded author/reviewer evidence and carried-forward assessments applicable at that point.
- `decisions` includes only decisions effective within the selected state’s boundary.
- `changes_since_previous` contains structured aggregate changes, work-item additions/removals/rescoring, finding-state changes, and alert changes, with the comparison event identity. Deterministic text summaries are rendered from this data.
- Unknown data is null/absent according to the final schema, not a fabricated zero. A baseline-only view has no review snapshot; an uninitialized view has neither.

`--verbose` affects text presentation only. JSON always returns the complete inspection model for the selected point. Scripts should not need to parse prose or inspect internal storage rows to obtain the supported information.

### 5.2 History response

History returns run identity, completeness/diagnostics, an ordered `events` array, and pagination metadata. Each event has:

- A stable event ID and discriminator: `baseline`, `review`, or `decision`.
- Recorded timestamp and available provenance.
- Associated snapshot, review-step, decision, gate, and finding identities as applicable.
- Relevant budget/governance summary at that event.
- Structured changes from the preceding relevant state.

Pagination includes the effective limit, `has_more`, and `next_before`. Empty history is a valid result for an existing uninitialized run. Do not expose filesystem line numbers or byte offsets as public cursors.

## 6. Correctness and architecture

### 6.1 Recorded history is authoritative

Default inspection reads recorded budget state and durable decisions. It does not rescore today’s plan, use today’s config to recalculate historical ceilings, or reinterpret an old advisory baseline as enforced.

Reuse pinned mode and thresholds and the existing governing-decision fold. For an uninitialized run, current configured policy may be shown only if labeled unpinned and resolved from the run’s effective plan directory, including mapped subprojects. The caller’s working directory must not change the result.

Recorded derived results and canonical reconstruction should agree. Preserve recorded verdict/route provenance; if records are incomplete or incompatible, expose a diagnostic rather than silently substituting a newly calculated historical outcome. Optional legacy metadata must not make otherwise readable history fail.

### 6.2 Read-only behavior

Neither command may capture a baseline, open a gate, create a prompt notification, record a workflow step, submit a decision, or mutate configuration. Read-only inspection must not call a gate path that materializes notifications as a side effect. Existing local index behavior may be reused, but inspection writes no authoritative run records.

An actionable gate requires canonical enforced-policy and run/decision-state support. A stored advisory gate-shaped record or `requiresHuman` diagnostic alone is insufficient. Display advisory routing predictions separately and explain completed/aborted runs without inviting an inapplicable decision.

### 6.3 Reuse and module boundary

Use the existing record-backed budget store, archived-run resolution, and governance readers as inputs to a shared inspection-model builder. Both JSON output and dedicated text renderers consume that model. Command adapters validate selection/pagination arguments and resolve run identity; they should not own budget formulas.

Keep the view independent of `budget.jsonl` layout. Decisions and findings may be assembled from multiple durable record types. Reuse existing aggregation and state-resolution functions for as-of views and delta construction; no parallel policy engine or new persistent summary store is required.

Bound rendered page size and avoid loading unrelated runs. Follow established corruption/diagnostic handling: disclose skipped or missing records and mark the view incomplete. If authoritative selected state cannot be resolved, return a structured error rather than presenting an apparently complete forecast.

## 7. Integration with existing commands

`run state --text` remains compact and adds a discoverability hint:

```text
Details: 5x review budget show --run <id> --text
```

Existing `run state` JSON and `review gate show` contracts remain compatible. `review budget show` supplies the explanation and historical context; `review gate show` remains the focused interface for inspecting an actionable decision. Governance mutations remain under `review decide`.

## 8. First-release scope and validation

The first release includes both commands, exact snapshot selection, decision-aware history, structured differences, pagination, dedicated text rendering, verbose evidence, and the `run state` hint.

Validation should cover:

- Original/current ledger and aggregates agree with canonical calculations; tests do not duplicate formulas in renderers.
- An initial review and a closure review show stable finding IDs and addressed outcomes even when the final `items[]` is empty.
- The example pattern `W = 28`, `R: 4 → 0` displays projected effort `32 → 28` without claiming measured work was reduced or rescored.
- Advisory alerts remain visible after completion without becoming actionable enforced gates.
- A budget/scope/architecture decision after the latest review affects default inspection and history, but not `show --snapshot` for an earlier review.
- Pinned mode/thresholds survive current config changes; unpinned policy is plan-scoped and independent of caller CWD.
- No baseline, baseline-only, off, legacy-compatible, completed, aborted, archived, and partially readable runs have explicit representations.
- Debt claims, changed/carried-forward assessments, and accepted-risk/deferred findings retain provenance and correct as-of boundaries.
- Pagination is stable across later appends and tied timestamps; cross-page delta meaning is unchanged.
- Unknown snapshot IDs/cursors fail clearly; malformed or missing records produce honest completeness/error results.
- Repeated inspection leaves authoritative record streams, prompt notifications, and decisions unchanged.
- Text handles narrow terminals, no color, large evidence, and untrusted control characters; JSON preserves full supported detail independent of `--verbose`.

Use deterministic record fixtures for model and renderer tests, and CLI integration tests for envelopes, formatting flags, archived/subproject resolution, pagination, and absence of authoritative writes. No live provider is needed.

## 9. Deferred work and implementation decisions

Deferred: TUI/charts, live forecasts against an unrecorded plan, arbitrary pairwise snapshot diffs, export formats, and additional governance controls.

During implementation, finalize nested JSON types using existing public contracts; define the shared event identity/order adapter for joining budget and decision streams; and confirm the canonical as-of reader and diagnostic behavior for legacy records. These choices must preserve the command semantics and read-only guarantees above.

The central design is settled: **`review budget show` explains a selected budget state; `review budget history` explains how review and human decisions changed it.**
