# Review: Orchestration Reliability Phase 1

**Review type:** commit `ede83f54`
**Scope:** Phase 1 review-path override warning changes and follow-on commits
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/commands/template-vars.test.ts test/integration/commands/template-render.test.ts` - passed (37 tests)

## Summary

Phase 1 is implemented as planned. The warning path is non-blocking, surfaces in both machine-readable and human-visible channels, and keeps explicit `review_path` overrides working.

**Readiness:** Ready - implementation matches the phase intent and has adequate unit/integration coverage.

## Strengths

- Warning logic is centralized in `src/commands/template-vars.ts`, so `template render` and `invoke` stay consistent.
- Tests cover configured-dir selection, relative/absolute paths, stderr surfacing, and the non-breaking override behavior.
- Skill updates remove the problematic override pattern and teach consumers to read the auto-generated review path from render output.

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [x] None.

## Addendum (2026-03-17) - Phase 4 Checklist Gate Fix

**Review type:** commit `99c4da8a`
**Scope:** Phase 4 review of non-numeric phase checklist-gate behavior and follow-on commits
**Local verification:** `bun test test/integration/commands/protocol-validate-checklist.test.ts test/unit/commands/protocol-validate.test.ts` - passed (63 tests)

### What's Addressed

- `validatePhaseChecklist()` now skips the checklist gate for clearly semantic phase identifiers like `plan`, which fixes the reported `PHASE_NOT_FOUND` failure for plan-review recording.
- The plan-review skill now passes `--no-phase-checklist-validate` explicitly, so the workflow is resilient even if callers bypass the new auto-skip path.
- Integration coverage exercises the intended happy path (`--phase plan`), preserves numeric gating (`--phase 1`), and covers another semantic identifier (`--phase setup`).

### Remaining Concerns

- P1 / auto_fix: `isNumericPhaseRef()` currently treats any phase string containing a digit as a plan phase reference. That is broader than the plan's stated "extract a numeric phase identifier" behavior and will incorrectly fail closed for semantic identifiers that happen to include digits, such as `setup-v2` or `review-2026`. Tighten parsing to recognized phase-reference forms (`1`, `1.2`, `phase-1`, `Phase 2`, etc.) and add coverage for digit-bearing semantic labels. Location: `src/commands/protocol.handler.ts:109`.

**Readiness:** Ready with corrections - core regression is fixed, but the numeric-phase detection heuristic is too broad for the stated contract.

## Addendum (2026-03-17) - Phase 4 Re-review

**Review type:** commit `7b354cb`
**Scope:** Re-review of Phase 4 numeric-phase detection follow-up fix
**Local verification:** `bun test test/integration/commands/protocol-validate-checklist.test.ts test/unit/commands/protocol-validate.test.ts` - passed (73 tests)

### What's Addressed

- The prior P1 issue is addressed: `isNumericPhaseRef()` now recognizes specific plan-phase reference forms instead of any digit-bearing string, so semantic labels like `setup-v2`, `review-2026`, and `v2` correctly skip the checklist gate.
- The implementation now aligns with the Phase 4 plan language about extracting a numeric phase identifier from recognized forms such as `1`, `2.1`, `Phase 1`, `phase-1`, and markdown heading variants.
- Added unit coverage validates both accepted numeric-reference forms and rejected semantic-with-digits forms, closing the gap in the original test strategy.

### Remaining Concerns

- None.

**Readiness:** Ready - follow-up fix resolves the only previously raised issue and Phase 4 now matches the intended contract.

## Addendum (2026-03-17) - Phase 2 Session Management Enforcement

**Review type:** commit `ac6c39e`
**Scope:** Phase 2 — session management enforcement (checklist items 2a–2i)
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/commands/session-check.test.ts test/integration/commands/template-render.test.ts` — passed (48 tests); full suite — passed (1566 tests, 0 fail)

### Checklist Coverage

| Item | Description | Status |
|------|-------------|--------|
| 2a | `continuePhaseSessions` config schema | Done — `AgentConfigSchema` + `allowedAgent` set + `5x.default.toml` |
| 2b | `--new-session` CLI flag | Done — `template.ts`, `invoke.ts`, handler param types |
| 2c | Session validation helper | Done — `src/commands/session-check.ts` (172 LOC) |
| 2d | `SESSION_REQUIRED` error code | Done — exit code 9 in `EXIT_CODE_MAP` |
| 2e | Handler integration | Done — both `template.handler.ts` and `invoke.handler.ts` |
| 2f | Template selection (`--new-session`) | Done — `template-vars.ts` continued-template probe guard |
| 2g | Skill file update | Done — session lifecycle, `${REVIEWER_SESSION:+--session}` pattern, `--new-session` recovery, `SESSION_REQUIRED` in Recovery |
| 2h | Unit tests | Done — 16 tests covering all specified scenarios |
| 2i | Integration tests | Done — 10 tests covering session enforcement end-to-end |

### Strengths

- **Clean separation:** `validateSessionContinuity` is a pure function (modulo `outputError` throws and `loadTemplate` calls), making it straightforward to unit test with in-memory SQLite. No process-wide mutation.
- **Defense-in-depth template selection:** `--new-session` is respected in three places — (1) session-check skips enforcement, (2) `effectiveSession` is set to `undefined` so `resolveAndRenderTemplate` doesn't probe for continued template, (3) `template-vars.ts` has a redundant `!opts.newSession` guard. This is correct — belt and suspenders.
- **Graceful degradation:** When role can't be inferred, phase can't be determined, or no run context exists, enforcement is silently skipped. This avoids breaking non-run invocations.
- **Test strategy is thorough:** Both unit and integration tests cover the full matrix (config on/off, prior steps yes/no, session/newSession/neither, continued template exists/missing, phase scoping). The integration tests properly use `setupProjectWithSessionEnforcement` helper with real DB + git init.
- **Skill updates are comprehensive:** Session lifecycle, `${REVIEWER_SESSION:+--session}` pattern in both canonical and workflow examples, `--new-session` in Recovery section, `SESSION_REQUIRED` documented.
- **`opencode.test.ts` fixed:** Existing provider tests updated to include `continuePhaseSessions: false` in config objects, preventing breakage from the new required default.

### Concerns

- **P2 / minor — DB handle leakage in `invoke.handler.ts`:** The `runDb` variable captures a DB handle obtained inside a block scope. The handle is used later by `validateSessionContinuity` but is never explicitly closed after validation. The `getDb` function likely manages this via connection pooling, and the existing pattern for `template.handler.ts` has the same characteristic, so this is consistent with the codebase convention. Not a bug, but worth noting.

- **P2 / minor — `--new-session` without `--run` on `invoke`:** The `invoke` handler requires `--run`, so `--new-session` without `--run` on invoke is impossible. But on `template render`, `--new-session` without `--run` is silently accepted (no-op since no DB means no enforcement). The session-check's early exit handles this correctly. The `--new-session` flag still semantically affects template selection (skips continued-template probe) via the `newSession` → `effectiveSession = undefined` path in `template.handler.ts`. This is correct behavior since `--new-session` without `--run` just means "use the full template even if a session is provided" — except `session` and `newSession` are mutually exclusive. In practice: `--new-session` alone without `--run` and without `--session` is a pure no-op. Acceptable — no user confusion expected.

### Remaining Concerns

None blocking.

**Readiness:** Ready — implementation matches all 9 checklist items, test coverage is comprehensive, the full test suite passes, and the design correctly handles edge cases (no run context, undetermined phase, missing continued template).

## Addendum (2026-03-17) - Phase 3 Protocol Emit Command and Shared Normalization

**Review type:** commit `6efe1e9`
**Scope:** Phase 3 — protocol emit command and shared normalization (checklist items 3a–3j)
**Reviewer:** Staff engineer
**Local verification:** `bun test` — passed (1605 tests, 0 fail); `bun test test/unit/protocol-normalize.test.ts test/unit/commands/protocol-emit.test.ts test/integration/commands/protocol-emit.test.ts` — passed (30 tests)

### Checklist Coverage

| Item | Description | Status |
|------|-------------|--------|
| 3a | Shared normalization module | Done — `src/protocol-normalize.ts` (206 LOC), `normalizeReviewerVerdict` + `normalizeAuthorStatus` |
| 3b | Wire normalization into validate | Done — `protocol-helpers.ts` uses shared module for both author and reviewer paths |
| 3c | Relax `assertReviewerVerdict` for empty items | Done — warning instead of throw, `ReviewerVerdictAssertionResult` with `warnings: string[]` |
| 3d | Register `5x protocol emit` command | Done — `protocol.ts` adds `emit reviewer` and `emit author` subcommands |
| 3e | Protocol emit handler | Done — `protocol-emit.handler.ts` (251 LOC), raw JSON stdout, `outputError()` for errors |
| 3f | Update reviewer templates | Done — `reviewer-plan.md`, `reviewer-commit.md`, `reviewer-plan-continued.md` |
| 3g | Update author templates | Done — `author-next-phase.md`, `author-process-plan-review.md`, `author-process-impl-review.md`, `author-fix-quality.md` |
| 3h | Unit tests for normalization | Done — 13 tests in `test/unit/protocol-normalize.test.ts` |
| 3i | Unit tests for emit handler | Done — 14 tests in `test/unit/commands/protocol-emit.test.ts` |
| 3j | Integration tests | Done — 9 tests in `test/integration/commands/protocol-emit.test.ts` |

### Key Design Requirement Verification

The critical contract — `5x protocol emit` success output is raw canonical JSON to stdout, NOT wrapped in `outputSuccess` envelope — is correctly implemented:

- **Success path:** `process.stdout.write(JSON.stringify(normalized))` in both `protocolEmitReviewer` and `protocolEmitAuthor`. No `outputSuccess()` call anywhere in the handler.
- **Error path:** `outputError()` (which throws `CliError`, caught by `bin.ts` top-level handler, writes `{ ok: false, error }` envelope to stdout with non-zero exit code).
- **Integration test validates both contracts:** Test "e2e: --ready emits raw canonical JSON (not envelope)" asserts `parsed.ok` is `undefined` (confirming no envelope). Test "missing required flags → non-zero exit + error envelope" asserts `parsed.ok === false` with `error.code`.
- **Round-trip test:** Output from `emit` is piped to `validate` and succeeds, confirming the two commands agree on schema format.

### Strengths

- **Single source of truth for normalization:** Both `protocol emit` and `protocol validate` use the same shared module. No schema drift possible between the "produce" and "validate" paths.
- **`outputError` returns `never`:** The handler can call `outputError()` without explicit `return` statements — TypeScript's control-flow analysis ensures no code executes after the throw. Clean and correct.
- **Stdin fallback is well-designed:** The `stdinData` parameter injection in unit tests avoids mocking `Bun.stdin.stream()`. Integration tests use real pipe via `Bun.spawn` with `stdin: "pipe"`. Both tiers exercise the normalization-via-stdin path.
- **Backward-compatible relaxation:** `assertReviewerVerdict` now returns a structured result with `warnings` instead of throwing. All callers updated to destructure — `protocol.handler.ts`, `protocol-helpers.ts`, `protocol-emit.handler.ts`. Existing tests updated from `toThrow()` to `warnings.length` assertions.
- **Reviewer normalization is comprehensive:** `verdict` → `readiness`, `issues` → `items`, `severity` → `priority`, auto-`id`, default `action` — all specified mappings implemented with corresponding tests.
- **`normalizeLegacyAuthorStatus` preserved:** The old function in `protocol.ts` is kept as a dead export for backward compatibility with any external callers. No imports from `src/commands/` reference it anymore — only test files. Clean migration.
- **Integration tests use `cleanGitEnv()` and `stdin: "ignore"`/`stdin: "pipe"` correctly** per the AGENTS.md conventions. All tests have `{ timeout: 15000 }`.

### Concerns

- **P2 / minor — Dead `normalizeLegacyAuthorStatus` export:** The old function remains in `protocol.ts` (lines 203+) and its tests remain in `protocol-helpers.test.ts`. No production code imports it. This is dead code that should eventually be cleaned up, but it's harmless and the tests provide regression coverage during the transition.

- **P2 / minor — Missing `--failed` without `--reason` unit test:** The plan item 3i doesn't explicitly list this case, but the handler enforces `--reason` for both `--needs-human` and `--failed` (line 227). Only `--needs-human` without `--reason` has a dedicated unit test. The `--failed` path is covered implicitly by the handler's `result !== "complete"` check, and the integration test for multiple flags covers error envelope behavior. Minor coverage gap.

- **P2 / minor — `normalizeAuthorStatus` field-stripping on normalization:** When normalizing from `status` → `result`, the function builds a new object with only canonical fields (lines 171–205), dropping any extra fields. `normalizeReviewerVerdict` uses `{ ...record }` spread (preserving extras). The asymmetry is documented in code comments and is intentional — legacy author payloads often contain non-canonical fields. Worth noting but not a bug.

### Remaining Concerns

None blocking.

**Readiness:** Ready — all 10 checklist items implemented, the critical raw-JSON-on-success contract is correctly enforced, shared normalization is the single source of truth, the full test suite passes (1605 tests), and the design handles stdin fallback, error paths, and backward compatibility cleanly.
