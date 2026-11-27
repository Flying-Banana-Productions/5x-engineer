# Review: Phase 1 — Delete the dead TUI path

**Review type:** Implementation commit `fa19978d614032b54f4089ba8588e8c2e9b4f2fb`  
**Scope:** W3 and the Phase 1 completion evidence, including operator acceptance criterion AC5 and debt claim DC0.  
**Reviewer:** Staff engineer  
**Local verification:** `bun run typecheck` passed. `bun test --concurrent --parallel=2 --dots --timeout 15000 test/unit` exited 0 with 3,473 passing tests and no failures. The recorded `bun run lint` and `bun run test` gates also passed (4,387 tests). Source CLI `init` in a fresh temporary Git repository printed no `--tui-listen` hint.

## Review Context

- Phase / review kind: Phase 1, initial material pass; enforced.
- Reviewed range: `1c282d540365c45b6b89411e3001aebe75acc215..fa19978d614032b54f4089ba8588e8c2e9b4f2fb`.
- Binding / review context: `47470180-49b7-44b4-b964-ed1df6e6b6e5` / `9d9911f5-f8c0-46a6-921e-f116387a33f0`.

## Summary

**Readiness: Ready** — all Phase 1 changes are in scope and AC5 is satisfied. No material findings.

The base had no consumers of the removed modules outside the retired TUI implementation and tests. At the reviewed endpoint, `src/tui/`, `src/utils/event-router.ts`, and `test/unit/tui/` are absent. `git grep` found no imports or `require` calls for them in `src`, `packages`, or `test`. The only SDK references in those paths are `src/providers/opencode.ts`, `src/providers/event-mapper.ts`, and `test/unit/providers/event-mapper.test.ts`, as expected for Phase 2. The plan-only diff checks the four tasks without changing their text.

**Operator warning:** The plan's front matter still says “Draft — pending review.” That label is outside the governing contract and does not override the recorded approval binding.

## Strengths

- Removed the dead attach and permission-reply paths and their tests without touching the active provider, dependency pins, or terminal prompt behavior.
- Removed the stale init announcement and the matching test-layout entry in `AGENTS.md`.

## Nonblocking follow-ups

- The literal `bun test test/unit` command reported zero failed tests but exited 1 on both the base (3,530 passes) and the reviewed endpoint (3,473 passes). The configured parallel flags exit cleanly; the bare command's exit status is pre-existing, not a regression from this deletion.
- The event mapper still mentions `event-router.ts` in a historical comment, not an import. Phase 2 already rewrites the mapper.

## Approved Credit Realization

| Claim ID | Realization | Realized architecture delta | Evidence |
|---|---|---:|---|
| DC0 | realized | -2 | At `fa19978d614032b54f4089ba8588e8c2e9b4f2fb`, all four modules and all three `test/unit/tui/` files are deleted, and `init` no longer prints the hint. The remaining 1.x SDK references are only in the provider, mapper, and mapper test, so swapping the SDK does not require porting attach or permission replies. |
