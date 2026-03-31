# Review: Plan List Command

**Review type:** `docs/development/030-plan-list-command.plan.md`
**Scope:** Staff review of the plan, related plan/run command architecture, parser/output helpers, config path semantics, and current docs/harness references.
**Reviewer:** Staff engineer
**Local verification:** Static review of `src/commands/plan-v1.handler.ts`, `src/commands/plan-v1.ts`, `src/commands/context.ts`, `src/db/operations.ts`, `src/db/operations-v1.ts`, `src/parsers/plan.ts`, `src/output.ts`, `src/paths.ts`, `test/integration/commands/plan-v1.test.ts`, `README.md`, `docs/v1/101-cli-primitives.md`, `src/harnesses/opencode/5x-orchestrator.md`, `src/harnesses/cursor/5x-orchestrator.mdc`

## Summary

The command is directionally right: disk-authoritative discovery plus batched DB enrichment fits the current architecture, and reusing the worktree-aware plan parsing model is the right baseline. But the plan is not quite implementation-ready as written. It constrains discovery and output shape to a flat plans directory even though the existing path contract treats `paths.plans` as a directory tree, and the test strategy leans too heavily on subprocess coverage for logic that should also be directly testable.

**Readiness:** Ready with corrections — the design is sound, but a few mechanical completeness fixes are needed before implementation.

## Strengths

- Good architectural fit: scans disk for source-of-truth plan files, then enriches from existing DB state instead of inventing new persistence.
- Correct reuse of current worktree behavior: reading the mapped worktree copy matches `plan phases` and preserves checklist accuracy during active runs.
- Sensible scope: no schema changes, no new dependencies, and documentation updates are appropriately included.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — Discovery should traverse the full `paths.plans` tree, not only top-level files

**Classification:** auto_fix

**Risk:** The plan currently proposes `readdirSync(dir, { withFileTypes: true })` over a single directory level. That will silently omit valid plans stored in subdirectories under `paths.plans`, even though the existing run/path contract allows any plan path under that directory tree.

**Requirement:** Update the implementation and tests to recurse under `config.paths.plans` and list every markdown plan beneath that root, not just immediate children.

**Evidence:**
- Non-recursive scan in plan: `docs/development/030-plan-list-command.plan.md:72-79`, `222-223`
- Existing contract is “inside configured paths.plans directory”, not “direct child only”: `src/commands/run-v1.handler.ts:718-735`

### P1.2 — Output should identify plans by relative path, not basename-only fields

**Classification:** auto_fix

**Risk:** The proposed `name`/`file` shape and text column use filename-only identity. That becomes ambiguous as soon as two plans share a basename in different subdirectories, and it gives operators no exact path to pass to `5x plan phases <path>`.

**Requirement:** Add a stable relative-path field (for example relative to project root or `plans_dir`) to the JSON payload and use that same path-oriented identity in the text table/tests. Basename/title can remain as convenience fields, but the primary identifier should be the path.

**Evidence:**
- Basename-only plan identity/output: `docs/development/030-plan-list-command.plan.md:100-107`, `126-139`
- Downstream inspection commands operate on explicit paths: `src/commands/plan-v1.ts:22-42`

### P1.3 — Add direct-call coverage for handler logic, not only subprocess tests

**Classification:** auto_fix

The planned integration cases are useful, but the new behavior includes sorting, filtering, worktree-path preference, empty-dir handling, and per-file parse fallback. Per the repo’s test split, that logic should also have unit-style handler coverage so regressions are caught without spawning the CLI for every case.

## Medium Priority (P2)

- The planned sort order (`finished first, then unfinished`) is counterintuitive for an inspection command meant to show active work. Either justify that ordering in the plan or switch to unfinished-first / active-first ordering. (`action: human_required`)

## Readiness Checklist

**P0 blockers**
- [x] Core architecture is compatible with current parser/DB/output patterns

**P1 recommended**
- [ ] Recurse through the full `paths.plans` tree (`auto_fix`)
- [ ] Expose a path-based plan identifier in JSON/text output (`auto_fix`)
- [ ] Add direct-call tests for listing/filtering/sorting/worktree resolution logic (`auto_fix`)
