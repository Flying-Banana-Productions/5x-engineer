# Phase 5 Review — documentation

## Verdict

- **Readiness:** ready_with_corrections

## Summary

- Phase 5 adds the planned docs surfaces: top-level README guidance, harness internals notes, and a new shared-skills README.
- Main gaps are documentation accuracy issues in `README.md`: one universal-flow example points users at OpenCode even though OpenCode uses `.opencode/...` paths, and the harness-choice table presents a Cursor plugin as an available install choice even though this commit only ships `opencode` and `universal`.

## What I checked

- Reviewed commit `223f3dfe55cdbdd25585bfd128e4a0c8733a5659`
- Reviewed Phase 5 in `docs/development/028-universal-harness.plan.md`
- Inspected:
  - `README.md`
  - `src/harnesses/README.md`
  - `src/harnesses/universal/README.md`
  - `src/skills/README.md`
  - `src/harnesses/factory.ts`
  - `src/harnesses/locations.ts`

## Findings

### 1. Universal install walkthrough uses OpenCode as the example host tool

- **Action:** auto_fix
- **Severity:** major
- **Location:** `README.md:127-134`

The universal workflow explicitly installs skills to `.agents/skills/` / `~/.agents/skills/`, and the same README later notes that OpenCode discovers skills from `.opencode/skills/` / `~/.config/opencode/skills/` instead.

Using `opencode` as the example session immediately after the universal install steps implies that OpenCode will load the universal install, which is not what the documented paths say. Replace that example with a genuinely agentskills.io-based host, or make the step generic and explicitly say the tool must discover `.agents/skills/`.

### 2. Harness selection table presents Cursor as a current install option

- **Action:** auto_fix
- **Severity:** major
- **Location:** `README.md:228-232`

The new table says to choose `cursor` when using a dedicated Cursor harness plugin, but this commit's bundled harness registry only exposes `opencode` and `universal` (`src/harnesses/factory.ts:22-27`). As written, the README reads like `cursor` is a presently available harness choice for this package.

Either mark Cursor support as planned/not yet shipped, or remove it from the current harness-choice table until the plugin exists.

## Assessment

- Not ready to call Phase 5 complete as written.
- Fix the two README accuracy issues above; both are mechanical doc corrections.

## Addendum — re-review after `782162ea5fabace672c37a0ed8616c022ba372db`

### Summary

- Re-reviewed the README fixes for R1 and R2.
- R1 is fixed: the universal harness walkthrough now uses generic host-tool wording instead of OpenCode-specific instructions.
- R2 is fixed: the harness-selection table now lists only currently shipped harnesses.
- I did not find new issues in the touched documentation.

### What I checked

- Reviewed commit `782162ea5fabace672c37a0ed8616c022ba372db`
- Inspected:
  - `README.md`

### Findings

- R1 closed.
- R2 closed.
- No additional blocking or mechanical issues found in this follow-up review.

### Updated Assessment

- Phase 5 is now complete and ready.
