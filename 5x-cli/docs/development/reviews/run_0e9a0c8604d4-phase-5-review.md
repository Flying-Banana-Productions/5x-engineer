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
