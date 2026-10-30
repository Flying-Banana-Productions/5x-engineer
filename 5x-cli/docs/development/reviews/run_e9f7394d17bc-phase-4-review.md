# Review: Plan 216 Phase 4 — Workflow assets

**Review type:** `9ceff964efcaa7c5fb618a6d38eea48d72b030a4..7482833af11c328d2c1aaca45a899c415c5fdb4d` (implementation-review context `589ee801-5db9-4fd9-a0af-f19eecbf70e5`)
**Scope:** Phase 4 (W1–W4 approved; Phase 4 delivers W4): schema 1 skeleton, five skills (one new), nine templates, shared runtime append, recovery diagnostics, acceptance tests, and the quality-gate remediation (`test/helpers/git-fixture.ts`, `test.serial` changes, AGENTS.md, evidence note)
**Reviewer:** Staff engineer (correctness, plan compliance, operability, test strategy)
**Local verification:** `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts test/unit/templates test/unit/review-governance/apply-context.test.ts test/unit/harnesses test/unit/skills`: 630 pass, 0 fail. `bun run lint`: clean (463 files). No changed test file has fewer `expect(` calls than at the base commit.

**Implementation plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` (approved at `4018531a`)
**Technical design:** N/A

## Review Context

- Phase / review kind: Phase 4 — Workflow assets; initial material pass
- Reviewed range: `9ceff964..7482833a` from the governance context. The plan file, review docs, and run records are excluded.
- Binding / review context: binding `5cc72c81-a5cb-4dda-80d8-007e4201bbb5`, context `589ee801-5db9-4fd9-a0af-f19eecbf70e5`, pinned mode advisory. No due claims, deferred decisions, or waivers.

## Summary

Phase 4 delivers what the plan asks for. The default and repo skeletons are schema 1 and load under `loadPlanDocument(raw, 1)`. `5x-plan-migration` is registered once in `BASE_SKILL_TEMPLATES`, and every harness installs it. The foundation skill only points at it. All nine templates carry the authority paragraph and have a version bump. `appendPlanReviewPromptContext` adds the paragraph to stale overrides on both the native and invoke paths, and integration tests check that it appears exactly once. Recovery diagnostics now name `5x review migrate-schema --help` and `5x-plan-migration`.

I found five P2 issues and no blockers. Every fix can be derived from the code and the plan:

- Generator how-to comments still sit inside the skeleton's contract.
- The once-only append check also scans the embedded code diff, so a matching diff line can suppress the paragraph.
- Schema 1 governing drift gets the schema 0 recovery text, and no drift diagnostic states the CLI requirement.
- The new git-fixture cache persists across runs and worktrees. Its key ignores the DB schema version, and a crash can leave its lock behind.
- The paragraph inserted into the reviewer-commit templates splits their numbered list.

**Readiness:** Ready with corrections — all findings are P2 `auto_fix`; the completion gate is met.

---

## What shipped

- **Skeleton:** `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE` and `docs/_implementation_plan_template.md` declare `plan-schema:1`. The declaration, `**Version:**`, `**Created:**`, `**Status:**`, and `## Revision History` are outside the contract. The title through Not In Scope is inside it. The note example is fenced.
- **Skills:** `5x-plan`, `5x-phase-execution`, and `5x-plan-review` teach the contract and note rules, plus the warning duty. The new `5x-plan-migration` skill covers recorded schema, lineage, equivalent and selective modes, operator digest confirmation, error codes, resume, the record-codec durability note, and the older-CLI fail-closed note. It has no reviewer snapshot or `--snapshot` flag.
- **Templates:** The nine templates have version bumps and the paragraph. Author templates state the schema 1 and schema 0 edit rules.
- **Runtime append:** `appendPlanReviewPromptContext` adds `PLAN_SCHEMA_AUTHORITY_INSTRUCTION` once when the prompt lacks it.
- **Diagnostics:** `planSchemaCommandMessage`, `schemaDriftReason`, `planFileGovernedReason`, and the new `planDriftRecoveryHelp` all point at the migrate-schema help and the migration skill.
- **Quality remediation:** Shared git fixtures (`copyInitializedRepo`, `commitAll`, `importCommitSequence`, `copyCommittedProject`). `test.serial` on the git-heavy plan-diff and protocol recording tests. The suite timeout stays at 15s.

---

## Strengths

- Native/invoke parity is proven end-to-end in `upgrade.test.ts`. A stale v1 `author-next-phase` override is rendered through `template render` and through `invoke` (sample provider echo). Both prompts contain the paragraph exactly once, and the override file is unchanged on disk.
- Harness coverage includes a fresh install, a restore through `harness sync`, and refusal to overwrite locally modified `5x-plan` / `5x-phase-execution` skills.
- The skeleton tests run the real projection: `authorityMarkdown` length parity, governing lines exclude Status and Revision History, and `parsePlan` on the mask finds phases 1 and 2. They cover the bundled skeleton, a configured `paths.templates.plan`, and the repo template.
- The executing plan stays schema 0. Its only marker lines are inside the Design Decisions fence.
- The quality remediation does not weaken any assertion and does not raise the timeout. The evidence note records the real gate output.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1 — Generator how-to comments sit inside the skeleton's contract

`src/templates/default-artifacts.ts:41`, `:54`, `:72`, `:107` are HTML how-to/example comment blocks between `<!-- 5x:contract:start -->` (`:31`) and `<!-- 5x:contract:end -->` (`:143`). The approved Design Decision puts "generator how-to comments" outside the contract. The `5x-plan` skill (`src/skills/base/5x-plan/SKILL.tmpl.md:63`) also tells authors that generator comments are outside it. The skeleton instead says "Delete generator comments before approval. A comment left inside the contract is governing text." The examples are labeled, so they cannot become rows or headings, and 4.1 allows that. The how-to prose is still governing, though. An author who keeps it gets those bytes bound into `comparisonBytes`, and deleting them later becomes `IMPLEMENTATION_PLAN_DRIFT`. That is the failure schema 1 is meant to remove. **Fix:** wrap each in-contract generator comment in a uniquely named `5x:note` block. Each one already sits between blank lines and is not inside a table, so the note grammar accepts it. Then drop the "governing text" sentence from the header. Extend `expectSchema1Skeleton` to assert that no `<!--` line is governing.

### P2.2 — The once-only check also scans the embedded code diff

`src/review-governance/context.ts:141` checks `prompt.includes(PLAN_SCHEMA_AUTHORITY_INSTRUCTION)`. Both call sites pass `resolved.prompt + codeDiffAppend` as `prompt` (`invoke.handler.ts:862`, `template.handler.ts:673`). `formatCodeReviewDiff` embeds up to 200 raw diff lines. Take a reviewer-commit override that lacks the paragraph and a reviewed range whose first 200 diff lines add it, for example any change to these templates or skills. The paragraph then appears only as a `+`-prefixed diff line and the append is skipped. Plan 4.2 requires the paragraph on override renders. **Fix:** decide from the template body only. Pass the code diff as a separate argument, or check `resolved.prompt` before concatenation. Keep the current byte layout so native and invoke stay identical. Add a unit case where the diff contains the paragraph and the body does not.

### P2.3 — Schema 1 governing drift gets the schema 0 "legacy" help, and no drift diagnostic states the CLI requirement

`planDriftRecoveryHelp` (`implementation-state.ts:236`) returns `PLAN_DRIFT_RECOVERY_HELP` for schema 1 drift unless the reason string contains a schema error code. That text opens with "Legacy schema 0 behavior remains supported" and offers migrate-schema "to record a schema transition". A schema 1 binding cannot migrate again (`PLAN_MIGRATION_CONFLICT`). Plan 4.3 says schema 1 wording says missing markers are malformed input. The Design Decision on binding fields says Phase 4 states the CLI requirement "in the migration skill and in the drift diagnostic". Neither help constant says it. **Fix:** return a schema 1 constant for every `recordedSchema === 1`. Point it at recover-plan / amendment for governing edits, keep the malformed-markers sentence and the migration skill pointer, and add the sentence "Schema 1 runs and migrated runs need a CLI that records `planSchema`." The reason-string sniffing then goes away. Add a test for the non-malformed schema 1 reason.

### P2.4 — Persistent git-fixture cache: key ignores DB schema, and a stale lock is never cleared

`test/helpers/git-fixture.ts` builds seeds under the system temp root. `test/setup.ts` only canonicalizes it, so the seeds outlive the run and are shared by every worktree on the host. `projectSeed` hashes `{version: SEED_VERSION, files, message, migrateDb}` (`:327`) but not `getMaxKnownSchemaVersion()`. Suppose a worktree with a newer DB migration builds the `migrateDb: true` seed first. A worktree on an older branch then copies a DB whose version is ahead of its CLI, and `runMigrations` throws "newer than this CLI's maximum known version". If the old seed builds first, newer branches copy an old-schema DB. Separately, if a run is killed between `mkdirSync(lock)` and the `finally` (`:103`), the `.lock` directory stays. Every later run then blocks the test thread for 10s in `Bun.sleepSync` and throws "timed out waiting for git fixture" until someone deletes it by hand. **Fix:** include `getMaxKnownSchemaVersion()` in the project seed payload. Treat a lock older than the wait window as stale (check `mtime`, remove it, retry once). Alternatively, scope seeds to a per-checkout directory.

### P2.5 — The paragraph splits the numbered list in the reviewer-commit templates

In `src/templates/reviewer-commit.md:25` and `reviewer-commit-continued.md:35`, the authority paragraph is an unindented block between steps 2 and 3. That ends the ordered list, so step 3 starts a new list. **Fix:** indent the paragraph as a continuation of step 2, or move it after the list as `reviewer-plan.md` does.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**P2 corrections**
- [ ] P2.1 Make in-contract generator comments non-governing (notes) and test it
- [ ] P2.2 Decide the once-only append from the template body, not the embedded diff
- [ ] P2.3 Schema 1 drift help for every schema 1 binding, including the CLI requirement
- [ ] P2.4 Key the project seed by DB schema version; recover stale fixture locks
- [ ] P2.5 Keep the reviewer-commit instruction list contiguous

---

## Nonblocking follow-ups

- `docs/_implementation_plan_template.md` is not in Files Touched. It is the default `paths.templates.plan`, so converting it matches 4.1 and the 5x-plan skill. Reconcile the Files Touched count when the plan is next revised.
- The harness-sync test simulates an "existing install" by deleting the installed skill directory. A fixture whose manifest predates `5x-plan-migration` would test the upgrade path more directly.
- `5x-cli/docs/development/216-phase-4-concurrent-test-evidence.md` is run evidence in the docs tree. Consider moving it to run records after the phase closes.

---

## Phase readiness

- **Phase 4 completion:** ⚠️ The completion gate is met: the focused suite passes, the paragraph appears once on bundled and override renders for native and invoke, a fresh install contains `5x-plan-migration`, and schema 0 diagnostics still say legacy is supported. The P2 corrections above should land before closure.
- **Overall production readiness:** Phase 4 is the last phase. After the P2 corrections, the feature is ready for its final review.
