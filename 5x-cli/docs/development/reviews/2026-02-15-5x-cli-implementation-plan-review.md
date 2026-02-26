# Review: 5x CLI Implementation Plan

**Review type:** `5x-cli/docs/development/001-impl-5x-cli.md`  
**Scope:** `5x` CLI orchestrator + agent adapters + signal protocol + template scaffolding + plan/review/execute loops + quality gates  
**Reviewer:** Staff engineer (correctness, reliability, operability, UX/safety)  
**Local verification:** Not run (static review: docs only)

**Implementation plan:** `5x-cli/docs/development/001-impl-5x-cli.md`  
**Technical design:** N/A

## Summary

This is directionally strong: it keeps the CLI as a state machine, preserves human gates, and builds on the existing command-template workflow rather than replacing it.

The draft has several spec gaps that will likely cause non-deterministic behavior in real projects (artifact path discovery, signal transport robustness, config loading across Bun/Node, and git safety in dirty worktrees). Fixing these now is cheaper than debugging “why did it pick that review file / branch / plan” once the loops are automated.

**Readiness:** Not ready — address P0 blockers (signal + artifact path contract, config runtime story, git safety invariants, adapter output contract) before implementation.

---

## Strengths

- **Aligned with repo workflow primitives:** maps cleanly onto existing author/reviewer commands and the plan/review artifact lifecycle in `README.md`.
- **Correct orchestration philosophy:** “smart prompts, dumb orchestrator” is the right boundary; the CLI should be predictable and auditable.
- **Human gates are explicit:** between phases + on `human_required` escalations, with a defined `--auto` escape hatch.
- **Phased delivery plan:** decomposition is sensible; early focus on parsing/status before adapters/loops is the right risk ordering.

---

## Production readiness blockers

### P0.1 — Make artifact paths deterministic (no directory scanning)

**Risk:** Multiple plan/review loops depend on “find latest review file if created by agent” and “search for new .md files in plans directory.” This will mis-associate artifacts in real repos (parallel workstreams, unrelated doc edits, editor autosaves, git pulls), leading to incorrect routing and unsafe auto-fix behavior.

**Requirement:**
- The CLI MUST choose and pass explicit output paths for: generated plan, review document, and (optionally) per-run logs.
- Agents MUST be instructed to write/update the artifact at the provided path.
- The CLI MUST never infer artifacts by “newest file” heuristics in the default path.

**Implementation guidance:**
- In `5x plan`, compute target plan path up front (sequence number, slug, or user-provided `--out`), pass it to the author prompt, and require the `5x:status` to echo it.
- In `5x plan-review` and `5x run`, compute a deterministic review path (date + plan slug) and pass it to the reviewer prompt; reviewer appends addendums into that file.

---

### P0.2 — Fix the signal protocol spec (transport + schema + versioning)

**Risk:** The signal approach is under-specified and internally inconsistent:
- `StatusBlock` schema does not include fields the plan says it needs (e.g., generated `planPath`, created `reviewPath`, phase number).
- HTML-comment wrapping + freeform strings is brittle (agents may emit `--` / `-->` sequences, multi-block output, or partial YAML), and “missing signal” fallbacks can silently do the wrong thing.

**Requirement:**
- Define a single canonical spec for `5x:status` and `5x:verdict` including required fields per command/loop.
- Include a `protocolVersion` field to allow upgrades without ambiguous parsing.
- Parsing MUST be resilient (multiple blocks → last wins; malformed → escalate), but MUST NOT substitute unsafe guesses (e.g., “assume completed”).

**Implementation guidance:**
- Add required fields:
  - `5x:status`: `result`, `artifactPaths` (or explicit `planPath`/`reviewPath`), `commit` (when relevant), `phase` (when relevant).
  - `5x:verdict`: `readiness`, `items[]`, and optional `reviewPath` for sanity checking.
- Prefer a delimiter that is robust to arbitrary text in strings. If you keep HTML comments, constrain fields to safe scalars and strongly instruct agents to avoid `-->` sequences in any field; otherwise move to a fenced block marker (visible but unambiguous) or a sidecar `.json` artifact written by the agent.

---

### P0.3 — Define the config runtime story for Bun + Node + compiled binary

**Risk:** `5x.config.ts` is TypeScript. The plan targets both Bun-native compilation and Node-compatible distribution, but does not specify how TS config is loaded in each runtime. This is a common footgun (works in Bun, breaks in Node; breaks when compiled; breaks under ESM/CJS mismatch).

**Requirement:**
- `loadConfig()` MUST work in the supported distribution modes (Bun runtime, Node runtime, and `bun build --compile` if you ship a binary).
- Failure modes MUST be crisp (actionable error telling user how to fix config format).

**Implementation guidance:**
- Pick one of:
  - Make config JS-only (`5x.config.js` / `.mjs`) and document it.
  - Keep TS but use a runtime loader that works in Node (e.g., `jiti`) and explicitly test ESM/CJS variants.
  - Support both TS + JSON, with precedence rules.

---

### P0.4 — Enforce git safety invariants (especially for `run` / `--auto`)

**Risk:** The current workflow tolerates a “dirty” environment because a human is orchestrating. Automating loops without hard safety checks increases the chance of committing unrelated changes, operating on the wrong branch, or repeatedly failing quality gates due to unrelated local state.

**Requirement:**
- Before any phase execution, the CLI MUST check and report: repo root, current branch, dirty working tree, and untracked files.
- Default behavior SHOULD be fail-closed: refuse to proceed when the working tree is dirty unless the user explicitly opts in (e.g., `--allow-dirty`).
- `--auto` MUST never bypass git safety checks.

**Implementation guidance:**
- Make `git status --porcelain` a first-class gate and surface a clear remediation path.
- If you allow dirty runs, record it in the run output and require explicit confirmation in interactive mode.

---

### P0.5 — Pin down adapter output contracts before building orchestration logic

**Risk:** The orchestrator design assumes adapters can reliably return `filesModified`, tokens/cost, and a stable “final output” string. For Claude Code `--output-format json`, the schema may change and may not map cleanly to the planned `AgentResult`.

**Requirement:**
- Define the minimum stable adapter contract that the state machines rely on (at most: `exitCode`, `output`, `duration`).
- Any optional fields (files/tokens) MUST not be required for correctness.

**Implementation guidance:**
- Build orchestration logic on: parsed `5x:*` signals + git observations (e.g., commit hash after author run), not on adapter-internal “filesModified.”
- Add a “schema probe” test for Claude Code JSON output and lock parsing to specific fields with good error messages.

---

## High priority (P1)

### P1.1 — Add resumability + run journaling

Long runs will be interrupted. Right now, the plan relies on plan/review docs as artifacts but does not define a CLI-owned run journal (what iteration, what state, which artifact paths).

Recommendation: write a small `run.json` (or append-only log) per invocation under a deterministic directory (e.g., `.5x/runs/...`) so `5x status` / `5x run` can resume safely.

### P1.2 — Make integration tests opt-in and CI-safe

Real Claude/OpenCode invocations should not run by default in CI. Gate them behind env flags and provide mocked golden tests as the default.

### P1.3 — Clarify `--auto` posture

Treat `--auto` as “unsafe/experimental” unless you also define hard guardrails (git clean required, explicit max iterations, explicit max retries, and clear abort conditions). Consider a separate `--auto --yes-really` style confirmation to avoid accidental use.

---

## Medium priority (P2)

- **Output capture size:** quality gate + adapter outputs can be huge; consider truncation + on-disk logs with pointers.
- **Non-interactive mode:** current plan defaults to abort; also support `--json` for scripting with explicit exit codes and machine-readable escalation payloads.
- **Template upgrade UX:** diff/prompt flow can be deferred, but checksum/version semantics should be designed early to avoid incompatible v1 artifacts.
- **Archive command:** Executive summary includes archive lifecycle but no explicit `5x archive` phase/command spec.

---

## Readiness checklist

**P0 blockers**
- [x] CLI owns and passes deterministic artifact paths (plan/review/logs); no "latest file" inference — *Addressed in v1.1: CLI computes paths upfront, passes to agents, verifies in `5x:status`; "search for new .md files" fallback removed*
- [x] Signal protocol finalized: schema matches needs, has versioning, robust delimiter/encoding — *Addressed in v1.1: `protocolVersion` field added, required fields per command defined, "last wins" + "malformed → escalate" rules specified, safe-scalar constraint on YAML values*
- [x] Config loading works in declared runtimes (Bun, Node, compiled binary if shipped) — *Addressed in v1.1: switched to JS-only config (`5x.config.js`/`.mjs`) loaded via dynamic `import()`; works in all three targets without TS loaders*
- [x] Git safety gates exist and are fail-closed by default; `--auto` never bypasses them — *Addressed in v1.1: `checkGitSafety()` gate added, `--allow-dirty` opt-in, `--auto` never bypasses*
- [x] Adapter contracts are minimized and validated; orchestration does not depend on fragile fields — *Addressed in v1.1: `AgentResult` reduced to `exitCode`/`output`/`duration` required; `filesModified` removed; orchestration uses `5x:*` signals + git observations; schema probe test added*

**P1 recommended**
- [x] Run journaling/resume behavior defined and implemented — *Addressed in v1.1: §5.4 defines `.5x/runs/<id>/run.json` journal with append-only events, resume detection on startup*
- [x] External integration tests are opt-in (env-gated) with stable mocked defaults — *Addressed in v1.1: live agent tests gated behind `FIVE_X_TEST_LIVE_AGENTS=1`; mocked golden tests run in CI by default*
- [x] `--auto` guardrails clarified and enforced — *Addressed in v1.1: §7.2 defines hard guardrails, configurable limits (`maxAutoIterations`, `maxAutoRetries`), first-use confirmation, explicit abort conditions*

---

## Addendum (2026-02-16) — Re-review after plan revisions

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.1)

### What's addressed (✅)

- **P0.1 deterministic artifacts:** Plan/review paths are computed by the CLI up front; prompts require agents to write to those paths; directory scanning fallbacks removed.
- **P0.2 signal protocol:** Canonical v1 schema is specified in `src/parsers/signals.ts` (protocolVersion, required fields per command); parsing rules are “last wins” and “malformed/missing → escalate,” with no “assume completed” guesses.
- **P0.3 config runtime:** Switched to JS-only config (`5x.config.js` / `.mjs`) with dynamic `import()` + explicit runtime verification targets (Bun, Node, compiled).
- **P0.4 git safety:** `checkGitSafety()` gate is fail-closed by default; `--allow-dirty` is explicit; `--auto` does not bypass safety.
- **P0.5 adapter contract:** Orchestrator relies only on `output`/`exitCode`/`duration`; schema-probe + env-gated live tests reduce brittleness.
- **P1 resumability + CI-safety + auto guardrails:** Run journaling (`.5x/runs/.../run.json`), env-gated live-agent tests, and `--auto` limits/confirmation are now specified.

### Remaining concerns / follow-ups

- **P1 — Template arg contract should match deterministic-path design:** Phase 3 template specs still describe only `$1` inputs. Update them to explicitly accept and echo CLI-owned paths (e.g., `planPath` target for `author-generate-plan`, `reviewPath` for reviewer commands) so the contract is unambiguous and testable.
- **P1 — `.5x/` hygiene:** Journal + confirmation state live under `.5x/`; ensure `5x init` adds `.5x/` to `.gitignore` (or documents it as required) to avoid accidental commits.
- **P1 — Archive scope mismatch:** Plan keeps “execute → archive” in-scope but still lacks a concrete `5x archive` command/spec. Either add a phase/task for it or move archive out of scope for v1.
- **P2 — Filename collisions:** Date-based review filenames and sequence-based plan filenames can collide in parallel runs; specify collision handling (e.g., include plan number in review filename and/or auto-increment on exists).
- **P2 — Signal encoding robustness:** The safe-scalar YAML constraint is workable but may be noisy (agents forgetting to quote). Consider switching to single-line JSON payloads inside the comment block (or writing a sidecar `.json`) when you rev templates.

### Updated readiness

- **Plan correctness:** ✅ — prior P0s are addressed; orchestration is now deterministic + fail-safe.
- **Ready to implement:** ✅ / **Ready with corrections** — proceed, but fold the P1 follow-ups into Phase 3 template work before relying on end-to-end automation.

---

## Addendum (2026-02-16) — Re-review after follow-up fixes

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.1, updated)

### What's addressed (✅)

- **Template arg/path contract:** Phase 3 templates now explicitly accept CLI-owned paths (`$2` plan output path for plan generation; `$2` reviewPath for reviewer commands; planPath passed for context where needed). This matches the deterministic artifact-path design.
- **`.5x/` hygiene:** `5x init` now appends `.5x/` to `.gitignore` and calls out idempotency tests; run journals + auto-confirmation state won’t be accidentally committed.
- **Plan path collisions:** `5x plan` target-path computation now specifies auto-increment on existing path (parallel run safety).

### Remaining concerns / follow-ups

- **P1 — Resolve `archive` scope contradiction:** Executive summary still lists “generate → review → execute → archive” in-scope while “Not In Scope” defers `5x archive` post-v1. Pick one and make it consistent across Scope, phases, and “Files Touched/Tests” planning.
- **P1 — Review filename uniqueness should include plan basename:** Review path uses `<date>-<plan-slug>-review.md` where slug drops the plan number (e.g., `001-impl-5x-cli` → `5x-cli`). This can collide across multiple plans for the same subject. Recommend using the full plan basename (e.g., `<date>-001-impl-5x-cli-review.md`) so the addendum model remains stable *and* unique per plan file.
- **P2 — Signal encoding robustness:** YAML-in-HTML-comment with “safe scalars only” is workable, but consider a v2 protocol using single-line JSON payloads (still inside comments) or a sidecar `.json` written by the agent to reduce prompt-compliance sensitivity.

### Updated readiness

- **Plan correctness:** ✅ — the orchestration contract is now mostly tight.
- **Ready to implement:** ⚠️ **Ready with corrections** — fix the archive-scope consistency + review filename uniqueness before coding Phase 3/4 so automation doesn’t encode a confusing/ambiguous contract.

---

## Addendum (2026-02-16) — Correction: Re-review of latest plan (v1.2)

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.2)

**Note:** My prior addendums referenced v1.1; the plan is now v1.2. I re-read v1.2 end-to-end and this addendum supersedes the “remaining concerns” status from the earlier addendum(s).

### What's addressed (✅)

- **Scope consistency:** “archive” is removed from in-scope; `5x archive` is explicitly deferred post-v1 (now consistent).
- **Template contracts:** Phase 3 template specs now explicitly pass CLI-owned artifact paths (`$2` target plan path, `$2` review path, plan path context), matching the deterministic-artifact design.
- **`.5x/` hygiene:** `5x init` appends `.5x/` to `.gitignore` + tests idempotency.
- **Collision handling:** `5x plan` target path auto-increments sequence number if the computed path exists.

### Remaining concerns / follow-ups

- **P1 — Review filename uniqueness across plans:** Review path still uses `<date>-<plan-slug>-review.md` where the example slug drops the plan number (`001-impl-5x-cli` → `5x-cli`). This can collide if you ever have multiple plans with the same subject slug. Recommend basing review filenames on the full plan basename (e.g., `<date>-001-impl-5x-cli-review.md`) to guarantee uniqueness while keeping the addendum model stable.

### Updated readiness

- **Plan correctness:** ✅
- **Ready to implement:** ✅ **Ready** — proceed. The remaining P1 is low-effort and worth doing early, but it should not block starting Phase 1–3.

---

## Addendum (2026-02-16) — Re-review after architectural rewrite (new Phase 1.1)

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.2, rewritten post-Phase-1)

**Scope of this addendum:** Plan-only review of the rewritten architecture/phasing. I am intentionally **not** reviewing the completed Phase 1 implementation/code in `5x-cli/` yet; we’ll review code after the new plan is signed off.

### What changed materially

- Orchestration state is now DB-backed (SQLite via `bun:sqlite`) and treated as source of truth.
- Prompt templates are bundled SSOT (no harness-scaffolded commands; `5x upgrade` removed).
- Plan-level file locking and git worktree support are added.
- New Phase 1.1 introduces DB/migrations/CRUD, locking, and template system prerequisites.

### Production readiness blockers

### P0.1 — Clarify and align the supported runtime/distribution story

**Risk:** The plan mixes “Node-compatible” expectations (e.g., Phase 1 checklist still includes Node runtime verification) with Bun-only primitives (`bun:sqlite`, `Bun.spawn`) and an explicit “Node runtime compatibility for DB is out of scope.” If runtime expectations aren’t explicit, you’ll ship a package that works only in one mode and fails confusingly in another.

**Requirement:**
- Define the v1 support matrix explicitly (Bun runtime, compiled binary, Node runtime). If Node runtime is not supported, remove Node test gates and any “node-compatible entrypoint” language from the plan and docs.
- If Node runtime *is* supported, replace Bun-only APIs or introduce an abstraction layer (DB + subprocess) with Node implementations.

### P0.2 — Fix DB schema idempotency and iteration semantics (agent_results uniqueness)

**Risk:** The schema relies on unique constraints for idempotency (`UNIQUE(run_id, role, phase, iteration)`), but `phase` is nullable in the DDL and `iteration` is underspecified. In SQLite, `NULL` in a UNIQUE constraint can permit duplicates, and unclear iteration semantics will cause either accidental overwrites or uncontrolled row growth.

**Requirement:**
- Make the idempotency key unambiguous and enforceable.
- Define what “iteration” means for each loop (plan-review loop, phase loop, quality retries, auto-fix cycles).

**Implementation guidance:**
- Prefer an explicit `invocation_id` (ULID) generated by the CLI per adapter invocation as the primary key, and store `phase`/`iteration` as query fields (not uniqueness).
- If you keep the existing uniqueness pattern: make `phase` NOT NULL with a sentinel (e.g., `-1`) for plan/plan-review, and define `iteration` as a monotonically increasing per-run (or per-phase) counter across *all* agent invocations.

### P0.3 — Make worktree cleanup non-destructive by default

**Risk:** The plan’s worktree cleanup flow includes deleting branches and forcing removal. That’s irreversible data loss if a branch has unmerged commits or a worktree has uncommitted changes.

**Requirement:**
- Default cleanup MUST not delete branches.
- Any destructive action MUST be explicitly gated (`--force`) and should validate safety (no unmerged commits, clean worktree) before proceeding.

---

## High priority (P1)

### P1.1 — Define log/output retention strategy (DB vs filesystem)

Quality gate output and other diagnostic blobs can be large. The plan currently stores quality gate command output inside `quality_results.results` JSON.

Recommendation: store structured summaries in DB and write full outputs to `.5x/logs/<run-id>/...`, persisting file paths in DB. Add truncation rules for terminal display.

### P1.2 — Template rendering escape/quoting rules

`{{variable}}` substitution is fine, but the plan should explicitly define escaping for literal `{{` sequences and how variables are quoted inside the YAML-comment signal blocks (since the protocol bans multiline values and `-->`).

---

## Updated readiness

- **Plan correctness:** ⚠️ — strong direction, but the runtime story + DB idempotency semantics need tightening.
- **Ready to implement:** ❌ **Not ready** — address P0.1–P0.3 first; otherwise you’ll build on ambiguous constraints that are painful to change after DB-backed state is in use.

---

## Addendum (2026-02-16) — Re-review after v1.4 hardening (ignore completed Phase 1)

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.4)

**Scope:** Plan-only review of the revised architecture/phasing. Still intentionally not reviewing the already-implemented Phase 1 code.

### What's addressed (✅)

- **Runtime story:** Plan now explicitly declares **Bun-only** runtime + compiled binary; Node runtime is not supported and the plan’s verification bullets were updated accordingly.
- **DB idempotency + iteration semantics:** `agent_results` is now keyed by CLI-generated ULID PK (no NULL-in-UNIQUE pitfall), and iteration meaning is written down for plan-review vs phase-exec.
- **Worktree cleanup safety:** Cleanup is non-destructive by default; branch deletion is explicitly gated (`--delete-branch`) and constrained to fully-merged branches; `--force` behavior is scoped to uncommitted changes, not unmerged branches.
- **Output/log retention:** Plan introduces filesystem logs under `.5x/logs/<run-id>/...` with DB storing only truncated output + paths.
- **Template escaping:** Template system defines `\{{` literal escape and “unresolved variables are a hard error,” with tests.

### Remaining concerns / follow-ups

### P0.1 — Resume/idempotency mechanism is still internally inconsistent

**Risk:** The plan still claims resume is “idempotent via unique constraints on `agent_results`,” but the schema no longer has a composite uniqueness constraint (only ULID PK). The separate claim “retries reuse the same ID” is also unsafe across crashes: if an invocation is re-run with the same ULID, `INSERT OR IGNORE` would drop the new result.

**Requirement:**
- Define *how* the orchestrator decides “this step already happened” on resume.
- Ensure re-running an invocation after interruption always records a result (no silent ignore).

**Implementation guidance:**
- Option A (recommended): add a composite unique constraint that matches your step identity, now that `phase` is NOT NULL (e.g., `UNIQUE(run_id, role, phase, iteration, template_name)`), and use `INSERT ... ON CONFLICT DO UPDATE` (or `REPLACE`) for retries.
- Option B: keep ULID-only PK, but persist a deterministic `step_key` (string) and use that as uniqueness for resume checks (or store `current_state` + a per-state attempt counter) rather than relying on reusing ULIDs.
- Update all resume prose to match the chosen mechanism (remove “unique constraints” language if not true).

### P1 — Use a non-colliding sentinel for “no phase context”

You’re using `phase INTEGER NOT NULL DEFAULT 0` as “plan/plan-review.” Many real plans use **Phase 0**. Prefer `-1` for “no phase context” and keep `0` available.

### P2 — Review file reuse across days

Review path uses `<date>-<plan-basename>-review.md`; that creates a new review file on a new day. With DB as SOT, you can reuse the last known `review_path` for a plan (from DB) to keep a single addendum trail without scanning.

### Updated readiness

- **Plan correctness:** ⚠️ — v1.4 is much tighter; only the resume/idempotency contract remains a real correctness risk.
- **Ready to implement:** ❌ **Not ready** — address P0.1 first (it’s foundational and will otherwise force painful DB migrations later).

---

## Addendum (2026-02-16) — Re-review after v1.5 resume/idempotency fixes (ignore completed Phase 1)

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.5)

**Scope:** Plan-only review of the revised architecture/phasing. Still intentionally not reviewing the already-implemented Phase 1 code.

### What's addressed (✅)

- **Resume/idempotency contract:** `agent_results` now has an explicit composite step-identity (`UNIQUE(run_id, role, phase, iteration, template_name)`) and uses `INSERT ... ON CONFLICT DO UPDATE` semantics; resume text + `hasCompletedStep()` align with this.
- **Phase sentinel:** `phase` uses `-1` for “no phase context,” preserving Phase 0 for real plans.
- **Review path continuity:** review path is persisted to DB and reused across subsequent runs for the same plan, avoiding “new review per day” churn while still avoiding directory scanning.

### Remaining concerns / follow-ups

### P1 — Clarify how `agent_results.id` interacts with step upserts + log files

You now have two identities: `id` (PK, log filename key) and the composite step key (conflict target). Specify whether an upsert updates `id` to the new invocation’s ULID (so log path tracks the latest attempt) or preserves the first `id` (and overwrites the log file / stores an explicit `output_path`). Without this, the “log path derivable from run_id + id” guarantee can silently point at stale logs after a re-run.

### P1 — Tighten step identity vs retry loops (quality retries)

Quality retries re-invoke the author in the same phase. If that uses the same `(role, phase, iteration, template_name)` identity, a resumed run may incorrectly treat the retry as “already completed.” Either:
- define `iteration` as the monotonic per-phase attempt counter that advances on each author re-invocation, or
- introduce an explicit `attempt`/`step_index` for agent invocations (distinct from `quality_results.attempt`).

### P2 — Minor spec hygiene

- The quality gate section still references `insertQualityResult()` in places while the DB ops section describes `upsertQualityResult()`; pick one name and use it consistently throughout the plan.

### Updated readiness

- **Plan correctness:** ✅ — the v1.4 P0 is resolved; v1.5 is coherent.
- **Ready to implement:** ✅ **Ready with corrections** — proceed, but close the P1 clarifications early (Phase 1.1) so the DB/log semantics don’t drift.

---

## Addendum (2026-02-16) — Re-review after v1.6 clarifications (ignore completed Phase 1)

**Reviewed:** `5x-cli/docs/development/001-impl-5x-cli.md` (v1.6)

### What's addressed (✅)

- **agent_results.id + log lifecycle:** Plan now explicitly states `id` is updated on step upsert; derivable log path always points to the latest attempt; older logs may be orphaned.
- **Quality-retry semantics:** `agent_results.iteration` is now defined as a monotonic per-phase/per-run counter that advances on *every* agent invocation (including quality-retry author re-invocations), preventing resume from misclassifying retries as already-completed.
- **Naming consistency:** quality DB writes consistently use `upsertQualityResult()`.

### Remaining concerns / follow-ups

- **P2 — Optional: add `updated_at` timestamps for upserted rows.** If `agent_results`/`quality_results` can be updated on resume, an `updated_at` column makes debugging/reporting clearer (distinguish first-run vs re-run overwrite). Not required for correctness.

### Updated readiness

- **Plan correctness:** ✅
- **Ready to implement:** ✅ **Ready**
