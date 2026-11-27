# Review: Phase 1 — Delete the dead TUI path

**Review type:** Implementation post-state revalidation at `64b0de6e9c178b3e2acfb8b69cb9faf5768ad1eb`  
**Scope:** Plan v1.7, Phase 1 (W3), operator acceptance criterion AC5, and approved debt claim DC0.  
**Reviewer:** Staff engineer  
**Local verification:** `bun run typecheck` passed. The revised contract command, `bun test --concurrent --parallel=2 --dots --timeout 15000 test/unit`, exited 0 with 3,473 passes and no failures. Running `5x init` from the reviewed source in a fresh temporary Git repository exited 0 with no `--tui-listen` hint. The new run's recorded `bun run lint` and `bun run test` both passed (4,387 tests, zero failures).

## Review Context

- Execution run: `run_98e4caae2772`; Phase 1 initial material pass, enforced.
- Reviewed range: `64b0de6e9c178b3e2acfb8b69cb9faf5768ad1eb..64b0de6e9c178b3e2acfb8b69cb9faf5768ad1eb`.
- Binding / review context: `d175e674-cbdd-4fff-90f3-93619ffe02fc` / `2bf99845-94a1-47db-a65f-358e157dccdc`.
- Approved plan commit: `013717dd9b44883897f65fb016a6d50a163efd82`.

## Summary

**Readiness: Ready** — the existing after-state satisfies the Phase 1 gate and AC5. No material findings.

The exact prepared code diff and plan-only diff are empty. This review certifies the tree at the recorded endpoint, not new implementation work. The earlier implementation and review commits (`fa19978d`, `ce74d860`) are historical context, not substitutes for this run's evidence.

Tree inspection confirms that `src/tui/`, `src/utils/event-router.ts`, and `test/unit/tui/` are absent. `git grep` found no importers or other runtime references to those paths in `src`, `packages`, or `test`. The test directory layout in `AGENTS.md` has no `tui/` entry. The only `@opencode-ai/sdk` references in the three checked directories are `src/providers/opencode.ts`, `src/providers/event-mapper.ts`, and `test/unit/providers/event-mapper.test.ts`, all in Phase 2 scope. The checklist parser reports all four Phase 1 tasks checked and executable.

**Operator warning:** The front matter says “Phase 1 complete.” That is informational and does not establish completion for this run. The Overview's present-tense description of the deleted TUI modules and init hint describes the original baseline, not instructions to restore them.

## Strengths

- Deletion leaves no live attach or permission-reply path to maintain or port and does not change the active provider's behavior in Phase 1.
- Source inspection, a real init smoke test, and the corrected unit gate verify both the code removal and its user-facing effect.

## Nonblocking follow-ups

- `src/providers/event-mapper.ts` mentions `event-router.ts` in a historical comment, not an import. Phase 2 already rewrites this mapper.
- The rendered prompt mentions `--review-context` near the emit example. The installed CLI takes it on `5x protocol validate reviewer --record`, not on `5x protocol emit reviewer`; the orchestrator should record the emitted verdict using the context above.

## Approved Credit Realization

| Claim ID | Realization | Realized architecture delta | Evidence |
|---|---|---:|---|
| DC0 | realized | -2 | The reviewed tree contains none of the four retired modules or `test/unit/tui/` files. Init did not print `--tui-listen`. The SDK references are confined to the provider, its mapper, and the mapper test, with no surviving attach or permission-reply implementation to port. This is the approved after-state, not credit for a change in the empty range. |
