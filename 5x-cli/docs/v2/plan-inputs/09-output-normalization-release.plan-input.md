# Plan input: Output normalization and v2 release cut

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-output-normalization-release` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

The v2 CLI has one documented output contract with deliberate exceptions and ships all breaking output/flag changes in one coordinated 2.0 release.

---

## In scope

- Define stable envelope data shapes and custom text formatters for `init`, `upgrade`, and `harness install`.
- Preserve current human-readable prose under `--text` while making default/JSON output machine-readable.
- Ensure all v2 commands and warning/remediation additions obey the final stdout/stderr contract.
- Document raw `protocol emit` success and streaming `run watch` as the only deliberate non-envelope success contracts.
- Remove redundant positive protocol flags while retaining native negative flags and actionable migration errors.
- Sweep the CLI for undocumented output exceptions and double-default boolean pairs.
- Update bundled skills, command docs, migration guidance, changelog/release notes, and compatibility tests together.
- Set v2 design/status documentation consistently for the completed release surface.

---

## Out of scope / deferred

- New command behavior unrelated to output normalization.
- General `--dry-run` standardization.
- Wrapping successful `protocol emit` output in an envelope.
- Changing `run watch` from a stream to a single response.
- Adding compatibility aliases for removed positive flags beyond a clear error/remediation.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - v2 versioning policy and complete breaking-change accounting.
2. `docs/v2/205-output-normalization.md` - canonical normalization and migration requirements.
3. `docs/v2/203-recovery-and-doctor.md` - final text remediation contract.
4. `docs/v2/204-run-context-ergonomics.md` - skill refresh coordinated with release output.
5. `docs/v1/100-architecture.md` - current output tiers and exceptions to supersede/document.

---

## Dependencies

- [ ] `01-recovery-and-doctor.plan-input.md` through `08-implementation-review-governance.plan-input.md` are merged and their output surfaces are stable.
- [ ] Area 201 remains implemented and its `harness sync`/freshness warnings are preserved.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- JSON mode does not implicitly answer interactive prompts; non-interactive behavior remains explicit through existing defaults/options.
- Text-mode errors remain stderr-only and JSON mode emits one envelope on stdout.
- `--dry-run` consistency remains outside v2 normalization.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 8 phases |
| Must touch areas | Init/upgrade/harness handlers, output formatters, protocol flags, docs/skills, migration and full integration tests |
| Forbidden for this slice | No new workflow semantics, no accidental wrapping of protocol/stream exceptions, and no piecemeal release of breaking changes |

---

## Exit criteria

- `init`, `upgrade`, and `harness install` emit documented success envelopes by default and preserve recognizable prose under `--text`.
- Every non-stream command has a documented JSON/text contract; only `protocol emit` success and `run watch` are explicit exceptions.
- Removed positive flags fail with a clear explanation that their behavior is already the default.
- Warnings and errors never corrupt JSON stdout and remediation remains visible to text-mode users.
- Updated bundled harness assets are fresh against the final v2 config/templates.
- Tests: golden JSON/text outputs, stderr separation, global exception sweep, removed-flag behavior, setup/upgrade migration, and full concurrent suite.
- Docs/release: one complete 2.0 migration table covers every intentional break.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Revisit provider-specific cancellation adapters, including OpenCode process lifecycle, against the shipped invocation-registry contract.
2. Use review-budget telemetry to decide whether enforcement should become the default.

**Suggested next slice** (optional): `-`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Existing scripts scrape grandfathered prose | Preserve `--text`/environment escape hatch and publish exact migration examples |
| Late v2 changes create undocumented exceptions | Run a command-wide contract audit only after all prior slices are stable |
| Skill updates leave installed assets stale | Regenerate via the area-201 sync path and verify manifests before release |
