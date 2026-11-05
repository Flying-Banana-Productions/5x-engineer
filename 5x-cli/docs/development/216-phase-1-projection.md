# Plan 216 Phase 1 projection

**Plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` revision 1.1
**Run:** `run_e9f7394d17bc`
**Phase:** 1 — Plan document projection

Phase 1 adds the pure schema reader. No drift, parser, span, binding, or prompt caller reads it yet. This plan file stays schema 0: the only plan edit is the phase 1 checkbox toggle.

## What landed

- `src/plan-schema/document.ts` exports `loadPlanDocument`, `PLAN_SCHEMA_AUTHORITY_INSTRUCTION`, `planDocumentByteOffset`, and `planDocumentByteRange`.
- `normalizeCheckboxMarkers` now lives in `src/review-governance/plan-markdown.ts`. `plan-amendment.ts` re-exports it. The regex and replacement are unchanged.
- Schema 0 returns the raw string as `authorityMarkdown` and `normalizeCheckboxMarkers(raw)` as `comparisonBytes`. It does not read markers. `governingLines` is the split of those bytes, dropping one trailing empty entry when the normalized string ends in a newline.
- Schema 1 space-fills non-governing lines in place, one UTF-16 code unit at a time, and keeps `\r` and `\n`. `comparisonBytes` is the post-splice checkbox-normalized `governingLines` joined with `\n`.
- Tests: `test/unit/plan-schema/document.test.ts`.

## Decisions

- A reserved marker is a line with at most three leading spaces, one HTML comment that contains `5x:`, and only trailing spaces or tabs. A leading tab, four or more spaces, or trailing non-space text is ordinary text. Expected schema 0 does not inspect those lines.
- File mode with no schema declaration is schema 0 even when well-formed contract or note markers are present. A reserved marker that does not match the grammar is still `PLAN_SCHEMA_INVALID` in file mode.
- The schema declaration may sit before or after the contract. It may not sit inside it. The first unsupported `plan-schema` token fails with `PLAN_SCHEMA_UNSUPPORTED` before duplicate-declaration checks.
- A blank line is empty or spaces and tabs only. A table row is `/^\s*\|/`, including separator rows, matching the budget-row test in `plan-markdown.ts`.
- Note `startLine` and `endLine` are 1-based and include the delimiter lines.
- The one-blank splice changes `governingLines` and `comparisonBytes` only. The authority mask keeps that blank line.
- Fence recognition matches `plan-markdown.ts`: 0–3 spaces or tabs, backtick or tilde runs, and a closing fence at least as long with no info string.
- `planDocumentByteOffset(raw, index)` is `Buffer.byteLength(raw.slice(0, index), "utf8")`. Callers must pass the raw string, not the mask.
- An empty governing-line list joins to `""`. One governing blank line is `[""]` and also joins to `""`. Drift comparison uses that join, as specified.

## Not wired

Phase 2 still owns expected-schema drift, parser masks, span verification, and binding fields. Phase 4 still owns rendering `PLAN_SCHEMA_AUTHORITY_INSTRUCTION`.

## Verification

From `5x-cli`:

- `bunx --bun tsc --noEmit` clean.
- `bun run lint` (`biome check src/ test/`, Biome 2.5.15) clean, 455 files.
- `bun run test` (`bun test --concurrent --dots --timeout 15000`): 3972 pass, 0 fail, 15359 assertions, 256 files.
