# Phase 5 Review — `5x phase finish`

## Verdict: Rejected

### Major — Composite runs quality gates in the caller directory rather than the run worktree

**Location:** `src/commands/phase.handler.ts:203-214`

`phaseFinishCore` passes `workdir: params.startDir` to `runQualityCore`. In the
quality core, a supplied `workdir` is treated as an explicit workdir and takes
precedence over the run's mapped worktree. Consequently, invoking `5x phase
finish --run <run-mapped-to-linked-worktree>` from the control-plane checkout
or another directory executes gates in that caller directory, while the
equivalent granular `quality run --record --run <id>` executes in the mapped
worktree. This breaks the composite's granular-command equivalence and can
validate the wrong source tree. The composite should preserve the absence of
an explicit workdir when calling the quality core.

### Major — Composite does not enforce author payload phase consistency before recording

**Location:** `src/commands/phase.handler.ts:270-281, 338-350`

The granular `protocol validate author --record --phase <P>` path rejects an
author result whose `phase` field differs from `<P>` (`PHASE_MISMATCH`). The
composite validates only the schema and then records `authorPayload` under the
command-line phase without performing that check. A payload declaring phase 2
can therefore be accepted and recorded at the phase-1 idempotency key. This
violates the specified equivalence with the protocol-record primitive and can
corrupt resume state.

## Verification

- `bun test --concurrent` — passed (2689 tests)
- `bun run lint` — passed

## Protocol-metadata recovery addendum

Re-check confirmed both findings against the Phase 5 implementation and the
granular primitives. They are directly derivable compatibility corrections and
require no product or design decision.

```json
{
  "readiness": "not_ready",
  "items": [
    {
      "id": "P1.1",
      "title": "Composite quality step overrides the mapped worktree with the caller directory",
      "action": "auto_fix",
      "reason": "phaseFinishCore passes params.startDir as workdir to runQualityCore, where an explicit workdir takes precedence over the run's mapped worktree. Omit workdir so phase finish matches granular quality run --record --run behavior.",
      "priority": "P1"
    },
    {
      "id": "P1.2",
      "title": "Composite author record accepts a payload phase different from --phase",
      "action": "auto_fix",
      "reason": "phaseFinishCore validates the author schema but does not compare result_json.phase with params.phase before recording. Apply the granular protocol validate --record PHASE_MISMATCH check before the composite records the author result.",
      "priority": "P1"
    }
  ],
  "summary": "Phase 5 remains not ready: the composite diverges from its granular quality and protocol-record primitives in two mechanical, auto-fixable compatibility cases."
}
```
