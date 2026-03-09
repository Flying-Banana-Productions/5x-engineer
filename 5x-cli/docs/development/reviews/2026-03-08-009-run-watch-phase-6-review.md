# Review: 009 Run Watch + Invoke Stderr (Phase 6)

**Review type:** commit `d643a9f` (+ follow-ons through `7052304`)
**Scope:** skill guidance updates in `src/skills/5x-plan/SKILL.md`, `src/skills/5x-plan-review/SKILL.md`, and `src/skills/5x-phase-execution/SKILL.md`, validated against the shipped `run watch` / `invoke --stderr` behavior and prior review rounds
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/commands/skills-install.test.ts test/commands/invoke.test.ts test/commands/run-watch.test.ts` (pass)

## Summary

Phase 6 is complete. All three bundled skills now tell operators how to monitor a run with `5x run watch --run <run-id> --human-readable` and when to opt into `--stderr` for harnesses that surface subprocess stderr. That guidance matches the implemented CLI behavior, and the earlier follow-on fixes closed the runtime gaps raised in prior review rounds.

**Readiness:** Ready - Phase 6 matches the plan, prior implementation concerns are closed, and the shipped skill guidance is consistent with the current CLI contract.

## Strengths

- Guidance is placed in the right spot: each skill's human-interaction section now covers both monitoring and stderr-streaming ergonomics where operators will actually look.
- The wording matches the product contract: `run watch` is presented as separate-terminal monitoring, and `--stderr` remains explicitly conditional on harness behavior rather than implied default usage.
- Documentation stays architecture-consistent with the implementation: logs are described as NDJSON under `.5x/logs/<run-id>/`, which aligns with the `session_start`/watch design shipped in earlier phases.
- Follow-on fixes from earlier review cycles mean the new guidance points at behavior that is now actually production-ready, not just planned.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `src/skills/5x-plan/SKILL.md` mentions `5x run watch --run <run-id> --human-readable`
- [x] `src/skills/5x-plan-review/SKILL.md` mentions `5x run watch --run <run-id> --human-readable`
- [x] `src/skills/5x-phase-execution/SKILL.md` mentions `5x run watch --run <run-id> --human-readable`
- [x] All three skills document using `--stderr` when the harness displays subprocess stderr output
- [x] Prior runtime/test gaps from earlier phase reviews are closed by follow-on commits through `7052304`

**P1 recommended**
- [x] Bundled skills still install cleanly via `5x skills install`
