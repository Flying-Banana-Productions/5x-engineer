# Review: 008 Refactor Command Handlers (Plan)

**Review type:** `docs/development/008-refactor-command-handlers.md`
**Scope:** Plan + related specs (`docs/v1/100-architecture.md`, `docs/v1/101-cli-primitives.md`) + current implementation (`src/bin.ts`, `src/output.ts`, `src/config.ts`, `src/project-root.ts`, `src/db/connection.ts`, `src/db/schema.ts`, `src/commands/{prompt,run-v1,invoke,diff,quality-v1,plan-v1,init,worktree}.ts`) + tests (`test/commands/*.test.ts`)
**Reviewer:** Staff engineer (maintainability, correctness, future migration)
**Local verification:** Not run (static review)

## Summary

The plan's direction is correct: isolating the CLI framework from command logic reduces churn for a future citty→commander migration and enables direct unit tests of handler behavior. As written, there are a few P0 plan/implementation mismatches (context resolution responsibilities, init test exports, and numeric/arg typing strategy) that will otherwise cause either immediate implementation thrash or a second refactor when commander lands.

**Readiness:** Ready with corrections — fix P0s to make "handlers stay stable across framework swaps" actually true.

## Strengths

- Clear intent: split "framework adapter" vs "command behavior," aligned with `src/bin.ts` as the citty boundary.
- Phased extraction with explicit completion gates; keeps scope bounded.
- Centralizing stdin + numeric parsing reduces copy/paste drift.
- Co-locating `*.handler.ts` with adapters preserves discoverability for future contributors.

## Production Readiness Blockers

### P0.1 — Define context helpers so they match current semantics (and don't force DB where unnecessary)

**Risk:** The proposed `resolveContext(): { projectRoot, config, db }` doesn't fit several commands (notably `quality-v1`, `invoke`, `plan-v1`, `diff`) and is ambiguous vs existing `resolveProjectRoot(startDir?)` semantics. If implemented as drafted, you either (a) open DB/run migrations for commands that don't need it (slower + more failure modes), or (b) re-introduce per-command boilerplate, defeating the point.

**Requirement:** Update the plan to split context resolution into two helpers with unambiguous inputs:
- `resolveProjectContext({ startDir?, providerNames? }) -> { projectRoot, config }`
- `resolveDbContext({ startDir?, providerNames?, migrate? }) -> { projectRoot, config, db }`

**Implementation guidance:**
- Name the directory input `startDir` (or `workdir`) rather than `projectRoot` to match `src/project-root.ts` behavior.
- Keep `migrate` default `true` for DB callers, but allow `false` for read-only / perf-sensitive commands if needed later.
- Treat `providerNames` as a first-class parameter because `loadConfig()` warning suppression is already relied on by `src/commands/invoke.ts`.

### P0.2 — Decide and document handler param typing strategy (or commander swap will still touch handlers)

**Risk:** Several proposed handler interfaces intentionally accept raw CLI strings (e.g., `tail?: string`, `sinceStep?: string`, `timeout?: string | number`). That keeps adapters "thin," but it also bakes "CLI parsing shape" into the handler contract. When commander is adopted (with real typed parsing), you'll either keep passing strings forever (leaving commander's parsing value on the table) or you'll change handler signatures—violating the stated goal that handlers remain identical.

**Requirement:** Pick one strategy and make it consistent across all handlers before starting Phase 2:
- **Preferred:** handlers take semantic types (`tail?: number`, `sinceStep?: number`, `timeoutSeconds?: number`, etc.); adapters perform parsing using shared utilities.
- **Alternative (explicitly accept):** handlers take raw strings and will continue to do parsing/validation even after commander; adapters convert commander output back to strings.

**Implementation guidance:**
- If you choose the preferred strategy, `src/utils/parse-args.ts` is still useful, but it becomes an adapter-layer helper.
- If you choose the alternative, rename utilities accordingly (e.g., `parse-cli-args.ts`) and explicitly state "handlers own CLI validation."

### P0.3 — Fix init helper export/test plan mismatch (`ensureSkills` is the actual test dependency)

**Risk:** `test/commands/init-skills.test.ts` imports `ensureSkills` re-exported from `src/commands/init.ts` today. The plan's Phase 6 export list for `init.handler.ts` omits `ensureSkills`, but later claims only one import path changes to `ensureSkillsFromInit`.

**Requirement:** Update the plan to keep `ensureSkills` available for tests after the refactor:
- Either re-export `ensureSkills` from `src/commands/init.handler.ts` and update the test import accordingly, OR
- Keep `src/commands/init.ts` re-exporting `ensureSkills` even if it becomes an adapter (and explicitly allow this exception to the "adapter-only" rule).

**Implementation guidance:** Current behavior is at `src/commands/init.ts` (re-export block) and `test/commands/init-skills.test.ts:11`.

## High Priority (P1)

### P1.1 — Make `stdin.ts` export shapes/types unambiguous and safe

`EOF`/`SIGINT` are runtime symbols today. If you want `unique symbol` typing, implement the actual exported constants accordingly (not just the type signature), and keep the call sites using `typeof EOF`/`typeof SIGINT`.

### P1.2 — Avoid confusing handler export names (`runInit` appears in two commands)

`run-v1.handler.ts` and `init.handler.ts` both want `runInit()`. This is not a runtime issue, but it is a readability/maintenance trap in grep-driven navigation.

Recommendation: use command-qualified names like `runV1Init()` vs `initScaffold()` (or similar).

### P1.3 — Keep "no business logic in adapters" realistic (allow minimal glue)

If you adopt semantic handler types (P0.2 preferred), adapters will necessarily do tiny parsing/normalization (string→number, defaults). That's acceptable; update Phase 7's "manual verification" wording to forbid IO/DB/git side effects in adapters, not all parsing.

## Medium Priority (P2)

- **P2.1 — Add micro-tests for new shared utilities:** `parseIntArg`/`parseFloatArg` and stdin sentinels are easy to cover without subprocess tests.
- **P2.2 — Document handler module boundaries:** explicitly state that handler files may import `output*`/DB/git/template/provider modules, but may not import `citty`.

## Readiness checklist

**P0 blockers**
- [x] Split context helpers (`project+config` vs `project+config+db`) and align parameter naming with `resolveProjectRoot(startDir?)`.
- [x] Choose handler param typing strategy (semantic types preferred) and update all handler interface drafts to match.
- [x] Fix init export/test dependency mismatch for `ensureSkills`.

**P1 recommended**
- [x] Clarify `stdin.ts` symbol exports/types and keep sentinel comparisons stable.
- [x] Rename handler exports to reduce collisions (`runInit` in multiple modules).
- [x] Update Phase 7 "adapter purity" wording to allow minimal parsing glue if needed.

---

## Addendum (2026-03-05) — Plan v1.1 Resolution

**Reviewed:** `docs/development/008-refactor-command-handlers.md` (v1.1)

### What's addressed

- **P0.1 resolved:** `resolveContext()` split into `resolveProjectContext()` (no DB) and `resolveDbContext()` (with DB/migrations). Parameter named `startDir` to match `resolveProjectRoot()`. `providerNames` is a first-class parameter. Quality/invoke/diff/plan use `resolveProjectContext`; run/worktree use `resolveDbContext`.
- **P0.2 resolved:** Semantic types adopted for all handler params. Numeric fields (`tail`, `sinceStep`, `iteration`, `tokensIn`, `tokensOut`, `costUsd`, `durationMs`, `limit`, `timeoutSeconds`) are `number` in handler interfaces. Adapters call `parseIntArg`/`parseFloatArg`/`parseTimeout` from `src/utils/parse-args.ts`. Design Decisions section documents the strategy explicitly.
- **P0.3 resolved:** `init.handler.ts` re-exports `ensureSkills` from `../skills/loader.js`. Test import path updates to `init.handler.js`.
- **P1.1 resolved:** `stdin.ts` symbols use `Symbol("EOF")`/`Symbol("SIGINT")` runtime values (not just type signatures).
- **P1.2 resolved:** `runInit` renamed to `runV1Init` (run-v1.handler) and `initScaffold` (init.handler). All run-v1 handler exports prefixed `runV1*`.
- **P1.3 resolved:** Phase 7 manual verification wording updated: adapters may contain arg parsing/normalization; forbidden items are IO side effects, DB calls, git operations, `outputSuccess`/`outputError` calls, and `citty` imports in handler files.
- **P2.1 resolved:** Phase 1 completion gate now requires unit tests for `parseIntArg`/`parseFloatArg` in `test/utils/parse-args.test.ts`.
- **P2.2 resolved:** Design Decisions section adds explicit handler module boundary: handler files may not import `citty`.

### Remaining concerns
- None.

### Updated readiness
- **Ready** — all review items resolved.
