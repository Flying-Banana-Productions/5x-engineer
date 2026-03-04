# Review: 007 v1 Architecture Implementation Plan

**Review type:** docs/development/007-impl-v1-architecture.md
**Scope:** Plan + referenced design docs (`docs/v1/100-architecture.md`, `docs/v1/101-cli-primitives.md`, `docs/v1/102-agent-skills.md`, `docs/development/006-impl-dashboard.md`) + referenced implementation (`src/agents/opencode.ts`, `src/utils/event-router.ts`, `src/utils/stream-writer.ts`, `src/templates/loader.ts`, `src/config.ts`, `src/db/schema.ts`, `src/db/operations.ts`, `src/lock.ts`, `src/git.ts`, `src/commands/run.ts`, `src/commands/worktree.ts`, `src/bin.ts`).
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

The direction (stateless CLI primitives + skills-driven orchestration + pluggable providers) fits the long-term maintainability goal and aligns with `docs/v1/*`. The current plan draft has several P0 correctness/phasing gaps that will cause either data loss (DB migration) or inability to meet phase completion gates (streaming/event normalization), plus one cross-initiative mismatch with the dashboard doc.

**Readiness:** Not ready — requires a few human decisions + plan re-sequencing to eliminate P0 blockers.

## Strengths

- Clear north star: primitives + immutable step journal; pushes orchestration complexity into skills where reasoning belongs.
- Provider interface is small and pragmatic; matches `docs/v1/100-architecture.md`.
- Good emphasis on idempotency (`INSERT OR IGNORE`) and resumability via full history (`run state`).
- NDJSON logging + permissions (0700) already proven in v0 OpenCode adapter; good reuse.
- Phased plan generally bottom-up; calls out explicit completion gates and test coverage.

## Production Readiness Blockers

### P0.1 — DB v4 migration can silently drop agent results (status vs verdict collision)

**Action:** human_required

**Risk:** Migration may lose data or fail with UNIQUE constraint violations. Current v0 `agent_results` uniqueness allows both `result_type=status` and `result_type=verdict` for the same `(run_id, phase, iteration, role, template)`; the v1 `steps` uniqueness `(run_id, step_name, phase, iteration)` plus proposed mapping `step_name = "{role}:{template}"` collides.

**Requirement:** Decide and document how to preserve both result variants (or intentionally drop one) during migration, then encode it.

Minimum acceptable options:
- Include `result_type` in `step_name` (e.g. `"author:author-next-phase:status"`), OR
- Merge into a single `result_json` shape with both payloads (and update `101-cli-primitives.md` accordingly), OR
- Prove (with code search + tests) that one of the variants is unreachable and can be safely discarded.

Add test coverage in `test/db/schema-v4.test.ts` to assert step counts match source rows and that both result variants survive.

### P0.2 — `5x run init` idempotency vs plan lock is underspecified (concurrency hole)

**Action:** auto_fix

**Risk:** Two orchestrators can act on the same plan concurrently if `run init` returns an existing active run without guaranteeing the lock is held by the current process. This undermines the core concurrency invariant in `docs/v1/101-cli-primitives.md`.

**Requirement:** Specify and implement a single invariant:
- `run init` MUST ensure the plan lock is held by this process before returning an active run.
- If an active run exists but the lock is held by another live PID, return `PLAN_LOCKED` (do not return the run).
- If lock is missing/stale, steal/acquire it and proceed.

### P0.3 — Phase 1 completion gate conflicts with Phase 12 (AgentEvent normalization)

**Action:** human_required

**Risk:** Phase 1 requires `runStreamed()` to emit normalized `AgentEvent` using `src/utils/event-router.ts`, but the referenced router currently writes to `StreamWriter` and does not produce `AgentEvent`. Phase 12 later proposes the refactor that would make this true. As written, Phase 1 cannot satisfy its own gate without doing Phase 12 work early.

**Requirement:** Re-sequence or redefine the gate:
- Either move the event-mapper/log-writer refactor earlier (before `invoke`/NDJSON work), OR
- In Phase 1, implement a minimal OpenCode SSE->AgentEvent mapper directly (do not depend on `StreamWriter`), OR
- Adjust Phase 1 gate to allow provider-native streaming temporarily and defer normalization to Phase 12.

### P0.4 — Migration plan assumes SQLite supports dropping columns

**Action:** auto_fix

**Risk:** SQLite does not reliably support `ALTER TABLE ... DROP COLUMN` across environments; migrations may fail. The plan also changes `runs` shape (remove `current_state/current_phase/review_path`, add `config_json/updated_at`) and timestamp semantics (`started_at` vs `created_at`).

**Requirement:** Write the v4 migration using a table-rebuild pattern (create `runs_new`, copy/transform data, drop old, rename) and be explicit about how existing timestamps map. Add a test that migrates a v3 DB with representative data.

### P0.5 — DB schema direction conflicts with dashboard design doc assumptions

**Action:** human_required

**Risk:** `docs/development/006-impl-dashboard.md` assumes v0 tables (`run_events`, `agent_results`, `quality_results`, `phase_progress`) and explicitly avoids DB migrations. This plan deletes/merges those tables. If both initiatives proceed, one will invalidate the other.

**Requirement:** Make an explicit decision:
- Update dashboard doc to read from v1 (`runs/steps/plans`) and revise its polling model, OR
- De-scope / delay the v4 destructive migration until after the dashboard ships, OR
- Provide a compatibility view/table layer for dashboard (and add it to the plan scope).

## High Priority (P1)

### P1.1 — Phase dependency claims are incorrect (Config/Factory coupling)

**Action:** auto_fix

`createProvider(role, config)` and OpenCode external mode depend on config keys (`author.provider`, `reviewer.provider`, `opencode.url`) that are introduced in Phase 8, but Phase 1 is marked dependency-free/parallelizable.

Recommendation: either move the minimal config additions (provider/opencode.url/maxStepsPerRun) earlier, or explicitly implement Phase 1 to be forward-compatible with missing keys (default provider=opencode, url undefined).

### P1.2 — Provider type definitions drift from `docs/v1/100-architecture.md`

**Action:** auto_fix

Examples in the plan differ slightly (e.g. `RunOptions.outputSchema` type, timeout units, naming/typing of JSONSchema). Tighten this so `src/providers/types.ts` matches the design doc exactly, and update the design doc if the change is intentional.

### P1.3 — `outputError()` as a hard-exit helper needs an explicit policy

**Action:** human_required

The plan proposes `outputError(...): never` (implies `process.exit`). That is fine for a pure CLI, but the repo currently exports types as a library and tests may need to assert on error objects rather than process termination.

Requirement: decide whether v1 commands:
- throw typed errors and let `bin.ts` render/exit, OR
- hard-exit inside command handlers (and standardize test harness around that).

### P1.4 — `run state` returning all steps can become a performance footgun

**Action:** human_required

Returning the full step list (including large `result_json` blobs) is simple, but can degrade with long runs and large results. Consider adding optional pagination/limits (`--since-step-id`, `--tail N`) while keeping the default behavior agent-friendly.

## Medium Priority (P2)

- **P2.1 (auto_fix):** Spell out `step_name` conventions and reserved prefixes in the plan (align with `docs/v1/101-cli-primitives.md`), especially for `event:*` and terminal run steps.
- **P2.2 (human_required):** Re-evaluate Phase 9 dependency additions (`@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`) vs package size/engine constraints; consider feature-flagging or optional deps.
- **P2.3 (auto_fix):** Clarify exit-code conventions per error `code` (e.g. template not found, non-interactive) so skills can reliably branch.

## Readiness Checklist

**P0 blockers**
- [ ] Resolve agent_results migration collision strategy (preserve status+verdict or justify dropping).
- [ ] Specify + enforce `run init` lock semantics for existing active runs.
- [ ] Fix Phase 1 vs Phase 12 streaming/event normalization ordering.
- [ ] Implement v4 migration with SQLite-safe table rebuilds + tests.
- [ ] Decide dashboard compatibility strategy for the schema break.

**P1 recommended**
- [ ] Correct phase dependency graph (especially Config/Factory coupling).
- [ ] Make provider types match `docs/v1/100-architecture.md` exactly.
- [ ] Decide `outputError`/exit policy and standardize command error handling.
- [ ] Consider `run state` pagination to avoid unbounded payloads.

## Addendum (2026-03-04) — Plan v1.1 Re-Review

### What's Addressed

- P0.1 resolved: v0 `agent_results` migration now disambiguates `result_type` by mapping to `step_name = "{role}:{template}:{result_type}"`; tests explicitly require both variants survive.
- P0.2 resolved: `run init` lock-first ordering is specified (acquire/steal lock, fail on live-PID lock, then return/create active run) + tests called out.
- P0.3 resolved: Phase 1 no longer depends on Phase 12; OpenCode provider owns a minimal SSE→`AgentEvent` mapper; Phase 12 becomes consolidation.
- P0.4 partially addressed: the plan now requires SQLite-safe table rebuild for `runs` shape changes and adds migration test expectations.
- P0.5 resolved (decision made): dashboard must be updated to v1 schema; no compatibility layer promised.
- P1.1 addressed: provider factory explicitly defaults when config keys missing; Phase 9 now depends on Phase 8.
- P1.2 addressed: provider types now match `docs/v1/100-architecture.md` (explicit `JSONSchema`, clarified timeout units).
- P1.3 addressed: explicit error-handling policy (`CliError` thrown; `bin.ts` renders JSON + exits) makes commands testable.
- P1.4 addressed: `run state` pagination (`--tail`, `--since-step`) and `getSteps()` API updated.
- P2.1/P2.3 addressed: step naming conventions + deterministic exit codes are now documented.
- P2.2 addressed: Codex/Claude SDKs moved to dynamic import + “optional peer deps” stance to avoid default install bloat.

### Remaining Concerns

- **P0 (auto_fix): runs timestamp mapping is still inconsistent with current v0 schema.** v3 `runs` uses `started_at`/`completed_at`; v1 wants `created_at`/`updated_at`. The plan text says “existing created_at preserved” but v0 doesn’t have it. Migration step 6 should explicitly map `created_at = started_at` (and carry over `completed_at` if still present), and update tests to assert the mapping.
- **P1 (auto_fix): doc drift risk for step naming.** The new `{prefix}:{action}:{qualifier}` convention (e.g. `author:implement:status`) differs from examples in `docs/v1/101-cli-primitives.md` (which currently show `author:implement`). Either update `docs/v1/101-cli-primitives.md` examples/spec or clarify that `:{qualifier}` is optional for v1-native steps but required for migrated rows.
- **P2 (human_required): “optional peer dependencies” packaging details.** If this repo is published to npm, confirm the intended package.json mechanism (`peerDependencies` + `peerDependenciesMeta.optional`, vs `optionalDependencies`) aligns with how you expect end-users to install/enable Codex/Claude providers under Bun.

Updated readiness: **Ready with corrections** — remaining issues appear mechanical + doc/packaging clarification.

### Plan v1.2 Resolution

All remaining concerns addressed in plan v1.2:

- **P0 resolved:** Migration step 6 now explicitly maps `created_at = started_at`, `updated_at = COALESCE(completed_at, started_at)`. Test expectations updated to assert the mapping. `101-cli-primitives.md` migration description updated to match.
- **P1 resolved:** `docs/v1/101-cli-primitives.md` migration example updated to `"{role}:{template}:{result_type}"`. Step naming conventions section clarified: v1-native steps use `{prefix}:{action}`, migrated v0 data uses `{prefix}:{action}:{qualifier}` for disambiguation. Skills should match on prefix.
- **P2 resolved (moot):** Plan v1.2 restructures providers as a plugin architecture. External providers ship as separate npm packages (`@5x-ai/provider-codex`, etc.) — each plugin owns its SDK dependency. No optional/peer dependencies in the core package. The packaging question is eliminated entirely.

Updated readiness: **Ready** — all review items resolved.
