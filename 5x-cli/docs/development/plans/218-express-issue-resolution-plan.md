<!-- 5x:plan-schema:1 -->

<!--
Generator guidance stays outside the contract, with the human document revision
and status. Obligations inside the contract are what a schema 1 approval binds.
Only contract content outside notes governs the work. Read other plan content as context. Surface apparent material requirements or conflicting instructions to the operator as warnings. Route necessary contract changes through amendment approval before acting. Informational claims such as review passed do not satisfy completion gates.
-->

**Version:** 1.0
**Created:** November 6, 2026
**Status:** Draft — pending review

<!-- 5x:contract:start -->

# Express Route for Single-Issue Resolution

## Overview

[Plan 217](217-explicit-issue-resolution-plan.md) gave 5x an explicit issue workflow: intake, then plan, plan review, implementation, implementation review, PR, and closure. Its compact mode shortens the plan document but removes no stage. A three-line fix therefore still costs at least five agent turns (intake, plan author, plan reviewer, implementation author, implementation reviewer), two runs, a plan, and a plan review. An experienced developer would make the change on a branch, have the diff reviewed, and merge it. They skip the plan, not the review.

This plan adds an **express route**. For a trivially small change, the diff replaces the plan, and a recorded review of that diff against the brief's acceptance criteria replaces plan approval. Express is one run and three agent turns: intake, fix, and diff review. The PR, reconciliation, and closure protocol from plan 217 is unchanged. The route is entered automatically or with operator confirmation. It is gated by **scrutiny categories** (paths and kinds of change), not by size limits. It escalates one way to the standard route, reusing the brief.

**Current behavior (verified against source):**
- Implementation admission triggers only for `author-next-phase` / `author-process-impl-review` or a numeric phase on an `author:` step (`src/review-governance/implementation-state.ts:93-110`). Under advisory or enforced governance it fails with `IMPLEMENTATION_APPROVAL_REQUIRED` unless exactly one approved plan-review run exists (`:790-830`; render-time guard `src/commands/template.handler.ts:389-420`). The only way around it is governance `off` or an unbound v1 compatibility run, which leaves no approval evidence.
- Implementation review context is prepared only when the run has an implementation binding (`template.handler.ts:603-640`), so an unbound run reviews against no recorded range.
- A run is keyed by one path, stored as `runs.plan_path` (`src/db/schema.ts`, latest migration 12 at `:648-650`) and in git-native `run.json` (`src/control-plane/record-types.ts:67-70`). `5x run init` requires that path to be inside `paths.plans` (`src/commands/run-v1.handler.ts:2269-2310`). It takes the plan lock by that path (`:2339`) and attaches an existing worktree whose branch is `5x/<slug>` or contains the slug (`:862-905`).
- The slug is the path basename without `.md` (`src/paths.ts:171-175`). Branch names (`src/git.ts:362-376`) and run-record directories (`src/control-plane/record-layout.ts:49-64`) derive from it. Keying a run by `<issues>/<slug>/brief.md` today would give every brief the slug `brief`, the branch `5x/brief`, and a substring branch match against any branch containing `brief`.
- `author-issue-intake` runs inside the plan-keyed planning run and writes `Planning run: <id>` into the brief (`src/templates/author-issue-intake.md:19,82`). The skill's `intake-association` recipe checks that line on resume (`src/skills/base/5x-issue-resolution/SKILL.tmpl.md:276-320`).
- Reviewer items already carry a `scopeClass` drawn from a plan/implementation union, which includes `implementation_defect` and `plan_defect`. A contextual validator chooses the domain (`src/protocol.ts:344-354`).
- `5x phase finish` can skip the checklist gate with `--no-phase-checklist-validate` (`src/commands/phase.ts:55-59`).

**New behavior:**
- Runs gain a **subject kind**: `plan` (all existing runs) or `issue-brief`. `5x run init|list|state --brief <path>` key a run by an issue brief. A brief's slug is its directory name. A new association's brief and reserved plan therefore share one slug, one `5x/<slug>` branch, one worktree, and one run-record directory. Plan parsing and plan handling paths are not taught about briefs.
- Intake for new associations runs in a brief-keyed **issue run**. On the express route the same run continues through fix, review, and seal. On the standard route it is sealed after intake, and plan 217's planning and implementation runs follow on the same branch.
- An express **admission record** binds the pinned brief commit and the admission base, in place of an approved plan. Express review context records the cumulative range from that base, plus a scrutiny report. An express review record links the reviewer verdict to that context. Seal requires an accepted express review of the final code, or a recorded escalation that restored the code to the base.
- **Scrutiny categories** (built-in plus project rules) are path globs and change types, each with action `escalate` or `confirm`. The CLI evaluates them on the actual diff. There are no line or file count limits.
- New templates `author-express-fix` and `reviewer-express`; `author-issue-intake` proposes a route. The `5x-issue-resolution` skill gains route selection, the express steps, escalation, the express PR marker, and express delivery identity.

**Prerequisites:** Plans 215, 216, and 217 are integrated on `main`. Reuse the RecordStore paired append, the reviewer protocol and verdict validation, `5x commit`, quality gates, and plan 217's publication and closure recipes. Re-anchor the code pointers above during implementation.

---

## Design Decisions

**The diff is the plan; the review is the approval.** For a trivially small change, a reviewer reading the actual diff against verbatim acceptance criteria is better evidence than a reviewer reading prose about the change. Express therefore drops plan authoring, plan review, the second run, and the bind step. It keeps intake (the source snapshot, acceptance criteria, and receipts depend on it), quality gates, and an independent review. It does not weaken implementation review, and it never runs with governance `off`. Express is unavailable when `reviewBudget.mode = "off"`, because without governance records there is no approval evidence. The skill then uses the standard route.

**No size limits; scrutiny categories instead.** Line and file counts are poor proxies for risk: a one-line auth change is riskier than a forty-line doc fix. The gate has three parts:
- (a) **Judgment**: intake proposes the route, and the reviewer can reject express as unsuitable.
- (b) **Mechanical scrutiny categories**: evaluated by the CLI on the real diff.
- (c) **Operator authority**.

Size is evidence the author and reviewer weigh, never a threshold.

**Scrutiny is configured as named rules, each with an action.**

```toml
[issues.express]
enabled = true
admission = "confirm"
builtinScrutiny = true

[[issues.express.scrutiny]]
name = "billing"
paths = ["src/billing/**"]
action = "escalate"
```

`admission` is `confirm` (default; the operator approves each express admission) or `auto` (admit without asking when intake proposes express and anticipates no scrutiny rule). Built-in rules, which a project can disable as a set with `builtinScrutiny = false` or override by name:

| Rule | Matches | Action |
|---|---|---|
| `dependencies` | dependency manifests and lockfiles (`package.json`, `bun.lock*`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.*`, `go.mod`, `go.sum`, `pyproject.toml`, `poetry.lock`, `requirements*.txt`, `Gemfile*`) | escalate |
| `persistence` | `**/migrations/**`, `**/*.sql`, `**/schema.*` | escalate |
| `security` | `**/auth/**`, `**/authn/**`, `**/authz/**`, `**/security/**`, `**/crypto/**`, `**/permissions/**` | escalate |
| `ci-release` | `.github/**`, `.gitlab-ci.yml`, `Dockerfile*`, `**/deploy/**` | escalate |
| `workflow-governance` | `5x.toml`, `5x.config.*`, `.5x/**`, configured `paths.templates` and `paths.prompts` | escalate |
| `structural` | change types: deletion, rename, file-mode change, binary file, symlink or submodule | confirm |

Path rules use the glob matcher 5x already uses for configured paths (confirmed in Phase 2). Change types come from `git diff --name-status -M --summary --numstat BASE..HEAD`. Evidence-only paths are excluded before matching: `paths.reviews`, `paths.planReviews`, `paths.runReviews`, and `paths.records`. An `escalate` hit blocks express review unless the operator records an explicit per-rule override; `auto` admission never records one. A `confirm` hit blocks until the operator confirms that rule. Confirmations and overrides bind the rule name and the matched path set, so a new matching path needs a new confirmation.

**Runs keyed by the brief through a subject kind, not by a stub plan.** A generated stub plan would put an unreviewed "plan" on disk and teach plan parsing, plan listing, drift detection, and amendment code to tolerate it. Instead:
- The stored run key stays the `plan_path` column and field. Renaming it would churn every reader for no behavior change.
- A new `subject_kind` (`plan` | `issue-brief`) is stored in a DB column (migration 13, default `plan`) and as an optional `run.json` field. An absent field means `plan`, so existing records decode unchanged.
- `subjectSlugFromPath()` returns the parent directory name for a path ending in `/brief.md` under the configured issues directory, and otherwise the plan basename. `planSlugFromPath()` keeps its signature and delegates to it, so branch, record-directory, doctor, backfill, and index-rebuild callers get the right slug without per-site changes. Every existing plan path keeps its current slug, and a test proves it.

Plan-only behavior is not offered on issue runs and fails with `RUN_SUBJECT_NOT_PLAN`: phase progress, checklist validation, plan drift, implementation admission, and plan-review templates. `run state` reports `subject_kind`, the brief path, and the express status in place of phases.

**The issues directory is derived, as in plan 217.** It is `<dirname(paths.plans)>/issues`. `run init --brief` requires the path to match `<issues>/<slug>/brief.md`, to be inside the repository, and not to be inside `paths.plans`. Otherwise it fails with `BRIEF_PATH_INVALID`. The brief need not exist yet at init: intake writes it.

**Intake moves into the issue run for new associations.** Route selection happens after intake, so intake cannot sit in a plan-keyed run that express would then abandon. For a new association the skill allocates the same names as today:
- the slug `NNN-issue-<n>-<short-slug>`;
- the reserved plan path;
- the brief directory `<issues>/<slug>/`.

It then runs `5x run init --brief <brief path> --worktree`. Because the brief slug equals the reserved plan slug, the later planning run attaches the same `5x/<slug>` branch and worktree through the existing attach rule.

The intake prompt writes `Intake run: <id>` in place of `Planning run:`. Briefs that carry `Planning run:` are legacy plan 217 associations: they resume on the standard route exactly as today and are never offered express.

**One run for express, cumulative review, one accepted interval.** Express steps record under phase `express`: `author:express-fix` and `reviewer:express`. These are never implementation admission, because the phase is not numeric. Every express review covers the whole cumulative diff from the admission base to the head under review. Express changes are small, so this costs little and removes plan 217's multi-interval delivery accounting. The accepted interval is `(baseCommit, reviewedCommit]` of the latest express review whose route is `complete`. `ready_with_corrections` is treated as `not_ready`: the author revises and the reviewer reviews again. There is no unreviewed correction shortcut.

**Records.** These are written with the existing RecordStore paired append into the run's `budget` stream, so express requires governance mode `advisory` or `enforced`:

| Kind | Fields |
|---|---|
| `express-admission` | `id`, `briefPath`, `briefCommit`, `baseCommit`, `authorizedBy` (`operator` \| `auto` \| `operator-request`), `scrutinyConfigHash`, `createdAt` |
| `express-scrutiny-decision` | `id`, `admissionId`, `rule`, `action`, `paths`, `decision` (`confirmed` \| `override`), `createdAt` |
| `express-review-context` | `id`, `admissionId`, `baseCommit`, `reviewedCommit`, `scrutiny` (matched rules, paths, and the decision IDs that cleared them) |
| `express-review` | `id`, `contextId`, `readiness`, `route` (`complete` \| `author_revision` \| `escalate`), `createdAt` |
| `express-escalation` | `id`, `admissionId` (or null before admission), `source` (`intake` \| `author` \| `reviewer` \| `scrutiny` \| `operator`), `reason`, `attemptHead`, `restoreCommit`, `createdAt` |

The reviewer route is derived, not chosen:
- any item with `scopeClass: plan_defect` gives `escalate` ("this change needs a plan");
- otherwise `not_ready` or `ready_with_corrections` gives `author_revision`;
- `ready` gives `complete`.

The express validation domain accepts only `implementation_defect` and `plan_defect`, and requires no `planWorkItemIds`, hunk citations, budget deltas, or debt fields. This needs no new protocol field.

**Commands live under the existing `review` family; there is no new command family.**
- `5x review express admit --run <id> --authorized-by <operator|auto|operator-request>`
- `5x review express confirm --run <id> --rule <name> [--override]`: `--override` is required for an `escalate` rule.
- `5x review express escalate --run <id> --source <...> --reason <one line>`

Admission checks, in order:
- the run is an active issue run;
- express is enabled and the mode is not `off`;
- the committed brief's first line is the plan 217 source marker;
- the brief has `Disposition: ready`, `Intake status: complete`, and `Route: express`;
- no admission or escalation exists yet.

It then records `baseCommit = HEAD`. Escalation records the attempt head. If any non-evidence path differs from the base, it writes one restore commit that returns those paths to `baseCommit` content (via `git checkout <base> -- <paths>` and removal of added paths), using the existing `5x commit` path with message `5x: restore express attempt to base`. Escalation is terminal for express on that run: express templates refuse to render afterwards, and an issue never moves from standard back to express.

**Guards are in the CLI, not only in prompts.**
- `author-express-fix` renders only on an issue run with an admission and no escalation (`EXPRESS_ADMISSION_REQUIRED`).
- `reviewer-express` prepares the express review context at render time in both native render and invoke, through the shared render path. It fails with `EXPRESS_ESCALATION_REQUIRED` (naming the rule, the paths, and the escalate command) or `EXPRESS_CONFIRMATION_REQUIRED` (naming the confirm command) when scrutiny is not cleared.
- `protocol validate reviewer --phase express --record` requires that context and records `express-review`.
- `run complete --status completed` on an admitted issue run requires either (a) the latest express review route `complete`, with no non-evidence path changed in `reviewedCommit..HEAD` and scrutiny clear at `reviewedCommit`, or (b) a recorded escalation, with no non-evidence path differing between `baseCommit` and HEAD. Otherwise it fails with `EXPRESS_REVIEW_REQUIRED`.
- An issue run with no admission (intake only, standard route) seals as today. `--status aborted` is always allowed.

**Express routing in intake is a proposal with stated evidence.** Intake adds these lines:
- `Route: express | standard` and `Route rationale:`;
- `Expected change:` areas and change kinds, which are not binding;
- `Anticipated scrutiny:` rule names, or `none`.

Intake proposes express only when all of these hold:
- the disposition is ready and intake is complete;
- the fix is localized and obvious;
- no unknown affects behavior;
- each `ACn` is verifiable by a test or direct inspection;
- no `escalate` rule is anticipated.

Otherwise it proposes standard. Intake stays read-only. An operator request ("quick fix issue #42") is passed to intake as `user_notes` and recorded as `authorizedBy: operator-request`. It does not bypass scrutiny rules. "Use the full workflow" always selects standard.

**Delivery and closure reuse plan 217.** The PR body, `Refs` only, receipt markers, the receipt preflight, closure branches a-g, and publication failures are unchanged. Two things are new:
- The express PR marker is `<!-- 5x:issue-resolution v1 source=<SRC> brief=<brief path> route=express -->`. It is accepted only when `brief=` matches a validated brief and the head branch is `5x/<slug>`.
- Express delivery identity: `BASE` is the admission `baseCommit`, and `R` is the accepted `reviewedCommit`. Checks: `BASE` is an ancestor of `R`, `R` of `FINAL`, and `FINAL` of `PR_HEAD`. Every commit in `BASE..PR_HEAD` is non-merge and is either evidence-only or in `BASE..R`. Changes to the brief directory after `BASE` are uncovered.

For the standard route on a new association, one check is added: no path outside the evidence paths and the brief directory differs between the issue run's intake base and the plan binding's `approvedPlanCommit`. This makes an escalated express attempt that was not restored stop delivery instead of riding in beneath `BASE`.

**Asset-impact matrix (AGENTS.md).**

| Surface | Change |
|---|---|
| Document skeletons (`default-artifacts.ts`) | Unchanged: express creates no plan; the brief format is owned by the intake prompt, and express reviews use the configured review template |
| Initial/continued prompts | `author-issue-intake` (route proposal, `Intake run:`); new `author-express-fix` (handles both initial and revision through an optional `review_path`); new `reviewer-express` with no continued variant (re-review always covers the cumulative diff, so there is no delta-only continuation). `author-generate-plan` accepts briefs with `Intake run:` and reads an escalation note from `user_notes`. Plan 217 reviewer prompts unchanged |
| Runtime-appended context / native-invoke parity | New express review context appended for `reviewer-express` through the shared `resolveAndRenderTemplate` path; parity test for native render and invoke |
| Workflow skills | `5x-issue-resolution`: brief-keyed intake, route selection, express steps, escalation, express PR marker, express delivery identity, resume rows. `5x-phase-execution`, `5x-plan`, and `5x-plan-review` unchanged (express does not use them; standard still does) |
| Install/override/upgrade/sync | Two new templates are picked up by `listTemplates()`; tests prove `--install-templates`, stale override warnings, and harness sync of the updated skill |

---

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Run subject kind: migration 13, optional `run.json` field, `subjectSlugFromPath`, `--brief` on run init/list/state, path validation, plan-only command guards, record/doctor/backfill compatibility | 5 | 1 | - | - | Persistence and record-format change across DB, control-plane records, run commands, and slug consumers. One new concept (subject kind) that later tooling must preserve, so +1. Keeps the plan path untouched, which is why there is no larger architecture cost. |
| W2 | Express governance: five record kinds, `review express admit/confirm/escalate`, scrutiny rule config and evaluator, restore-to-base escalation, seal guard, express validation domain | 8 | 2 | - | - | A new approval path beside implementation admission, with its own persistence, CLI guards, and git mutation (restore commit). Uncertainty sits in fitting the express domain into existing verdict validation and the RecordStore paths without touching plan-bound governance. +2: a second, smaller approval route is permanent maintenance surface. |
| W3 | Templates: `author-issue-intake` route proposal, new `author-express-fix` and `reviewer-express`, `author-generate-plan` brief compatibility, registry and step names, render guards and appended express context with parity | 3 | 1 | - | - | Prompt work crossing templates and the render/invoke path. +1 for two more registered templates. |
| W4 | `5x-issue-resolution` skill: brief-keyed intake association, route selection and confirmation, express Steps, escalation, express PR marker and delivery identity, discovery and resume changes, recipe fixtures | 5 | 0 | - | - | Same skill and the same fixture harness as plan 217; new branches, recipes, and stub-gh/git fixtures, no new production abstraction. |
| W5 | Install, upgrade, override, and sync coverage; configuration and CLI docs; operator docs; smoke matrix rows; final verification | 2 | 0 | - | - | Tests and docs across existing trees. |

### Surface Snapshot

- Subsystems: 7
- Production files: 30
- Persistent/external boundaries: 3

The subsystems are the DB and control-plane records, run commands, review governance, configuration, prompt templates, workflow skills, and user documentation. The production-file count is the Files Touched table's non-test rows, with each listed file counted once. The boundaries are the SQLite schema, the git-native run records (`run.json` and the `budget` stream), and git history mutation through the escalation restore commit. GitHub surfaces are unchanged from plan 217.

---

## Acceptance Coverage

This plan implements an operator request (November 6, 2026), not a GitHub issue. The operator's decisions are bound here.

| Source | Criterion | Work / phase | Evidence required |
|---|---|---|---|
| operator | AC1: a trivially small issue resolves through one run with intake, fix, and diff review, no plan or plan review, and the same PR/closure protocol | W2, W3, W4 / Phases 2-4 | Express end-to-end integration test with echo providers from issue run init to sealed run; skill render tests; smoke row |
| operator | AC2: express entry is automatic or operator-confirmed (`admission = auto \| confirm`, default `confirm`) | W2, W4 / Phases 2, 4 | Admission tests for both modes and `authorizedBy`; skill render shows the confirmation step |
| operator | AC3: express runs are keyed by the brief with no stub plan and no plan-parser changes | W1 / Phase 1 | Subject-kind tests; `git diff` of `src/parsers/` and `src/plan-schema/` empty for this plan; plan-only commands refuse issue runs |
| operator | AC4: no size limits; scrutiny is path and change-type categories with escalate/confirm actions, evaluated on the actual diff | W2 / Phase 2 | Evaluator unit tests per built-in rule and change type; config schema has no count limits; override and confirmation binding tests |
| operator | AC5: escalation is one-way and reuses the brief; an escalated attempt cannot reach delivery unreviewed | W2, W4 / Phases 2, 4 | Escalate restore tests; seal guard tests; standard-route intake-base check fixture |

---

## Phase 1: Run subject kind and brief-keyed runs

**Completion gate:** An issue run can be initialized, listed, inspected, locked, mapped to a worktree, recorded, and sealed by brief path. Its slug, branch, and record directory equal the reserved plan slug. A later plan run for that slug attaches the same worktree. Every existing plan path keeps its slug. Plan-only commands refuse issue runs. `bun test test/unit/db test/unit/commands test/unit/utils` and the new integration tests pass.

### 1.1 Persistence

- `src/db/schema.ts`: migration 13 adds `runs.subject_kind TEXT NOT NULL DEFAULT 'plan'`. `src/db/operations-v1.ts` writes it on create and returns it on read.
- `src/control-plane/record-types.ts` / `record-layout.ts`: optional `subject_kind` on `RunRecordSummary`. `encodeRunJson` omits it for `plan`, and `parseRunJson` treats absence as `plan` and rejects unknown values. Confirm that a CLI built before this plan decodes a `run.json` with the field. If it does not, record the incompatibility in the CHANGELOG under the existing record-format rules, and do not raise `format_version`.
- `src/records/backfill.ts`, `index-rebuild.ts`, and `src/doctor/checks/records.ts`: carry `subject_kind` through, and compare slugs with `subjectSlugFromPath`.

### 1.2 Slug and path rules

- `src/paths.ts`: add `issuesDirFor(plansDir)` and `subjectSlugFromPath(path, opts?)`, and make `planSlugFromPath` delegate to it. The brief rule applies only to the exact shape `<issues>/<slug>/brief.md`.
- `src/git.ts`: `branchNameFromPlan` and `isBranchRelevant` use the subject slug. Add a test that a brief slug never degenerates to `brief`.

### 1.3 Run commands

- `src/commands/run-v1.ts` / `run-v1.handler.ts`: `--brief <path>` on `init`, `list`, and `state`, mutually exclusive with `--plan`. Init validates the brief shape (`BRIEF_PATH_INVALID`), takes the lock by brief path, and uses the existing worktree create/attach logic. JSON envelopes add `subject_kind` and, for issue runs, `brief_path`. Issue-run `state` omits phase progress.
- Guards (`RUN_SUBJECT_NOT_PLAN`) on issue runs:
  - `plan phases`, `phase finish` when checklist validation is on;
  - implementation-admission paths;
  - `review implementation bind`;
  - plan-review templates.
- `FIVEX_RUN`, linked-worktree mapping, and `.5x/current-run` resolution work for issue runs unchanged.

### 1.4 Tests

- Unit: the migration on an existing DB keeps rows as `plan`; `run.json` round-trips with and without the field; slug tests on every plan path fixture in `test/` show no change; the brief shape is accepted and near-misses are rejected; guards return `RUN_SUBJECT_NOT_PLAN`.
- Integration (`test/integration/commands/run-brief.test.ts`; `copyInitializedRepo`, `cleanGitEnv()`, `stdin: "ignore"`, `timeout`):
  - `run init --brief --worktree` creates `5x/<slug>`;
  - after `run complete`, `run init --plan <reserved plan> --worktree` attaches the same worktree;
  - records land in `runs/<slug>/<run>`;
  - `run list --brief` and `run state --brief` report `subject_kind`;
  - `doctor` reports no issue for an issue run.

- [ ] Add migration 13 and DB read/write of `subject_kind`
- [ ] Add optional `run.json` `subject_kind` with compatible decode; thread through backfill, index rebuild, doctor
- [ ] Add `issuesDirFor`, `subjectSlugFromPath`; delegate `planSlugFromPath`; update branch helpers
- [ ] Add `--brief` to run init/list/state with validation, locks, worktree attach, envelopes
- [ ] Add `RUN_SUBJECT_NOT_PLAN` guards to plan-only commands
- [ ] Add unit and integration tests above, including unchanged slugs for all existing plan fixtures

---

## Phase 2: Express governance and scrutiny

**Completion gate:**
- `review express admit|confirm|escalate` record the specified records with the specified checks.
- The scrutiny evaluator matches every built-in rule and change type, and project rules, on a real diff.
- Escalation restores non-evidence paths to base in one commit.
- `run complete` enforces the seal guard.
- Express mode is refused when `reviewBudget.mode = "off"`.
- Express verdict validation accepts only the express domain.
- `bun test test/unit/review-governance test/unit/commands` and the new integration tests pass.

### 2.1 Configuration

`src/config.ts`: an `IssuesSchema` with `express: { enabled (default true), admission (confirm | auto, default confirm), builtinScrutiny (default true), scrutiny: array of { name, paths?: string[], changes?: ("deleted" | "renamed" | "mode" | "binary" | "symlink" | "submodule")[], action: "escalate" | "confirm" } }`. A rule needs `paths` or `changes`. A project rule whose name equals a built-in rule replaces it. Register the key in `config-registry` so `5x config show` displays it. Add commented defaults to `src/templates/5x.default.toml`. The schema has no count or size field.

### 2.2 Evaluator and records

- New `src/review-governance/express.ts`. It holds the built-in rule table and `evaluateExpressScrutiny({ repoRoot, base, head, excludedPaths, rules })`, which returns matched rules with paths and change types from one `git diff --name-status -M --summary --numstat` call. Reuse `implementationExcludedPaths` (`src/commands/template-vars.ts:196`) for evidence paths, and confirm which glob matcher configured paths already use.
- Record kinds and builders in `src/review-budget/record-lines.ts` following the existing builder pattern. Store accessors live in `src/review-governance/store.ts`.
- `scrutinyConfigHash` is a hash of the effective rule list, recorded at admission. If later evaluation runs under a different hash, it is reported in the context record and in `run state`.

### 2.3 Commands

`src/commands/review.ts` plus a new `src/commands/express.handler.ts`, implementing `admit`, `confirm`, and `escalate` with the checks in Design Decisions. Error codes:
- `EXPRESS_DISABLED`
- `EXPRESS_MODE_OFF`
- `RUN_SUBJECT_NOT_ISSUE`
- `EXPRESS_BRIEF_NOT_READY` (with the failing line named)
- `EXPRESS_ALREADY_ADMITTED`
- `EXPRESS_ESCALATED`
- `EXPRESS_RULE_UNKNOWN`
- `EXPRESS_OVERRIDE_REQUIRED` (confirming an `escalate` rule without `--override`)

`escalate` before admission records `source: intake` with no restore commit. Each success envelope includes the next commands, with the run filled in.

### 2.4 Seal guard and verdict domain

- `runV1Complete` (`run-v1.handler.ts:4329`): the express seal guard (`EXPRESS_REVIEW_REQUIRED`), reporting the uncovered paths.
- `src/protocol.ts` contextual validation: phase `express` selects the express domain. Recording derives the route as specified.

### 2.5 Tests

- Unit (`test/unit/review-governance/express.test.ts`): each built-in rule, each change type, project override by name, `builtinScrutiny = false`, evidence-path exclusion, confirmation bound to its path set (a new path re-triggers it), and `--override` required for escalate rules.
- Unit: the route derivation table; the express domain rejects `acceptance_required` and plan-review classes and needs no `planWorkItemIds`; `isImplementationAuthorAdmission("author:express-fix", "express")` is false.
- Integration (`test/integration/commands/review-express.test.ts`):
  - admit refusals for each failed check;
  - admit success records `baseCommit`;
  - escalate after code commits writes one restore commit, and the tree equals base for non-evidence paths;
  - escalate with no code writes no commit;
  - seal refused without a review;
  - seal accepted after escalation;
  - mode `off` refused.

- [ ] Add `issues.express` config schema, registry entry, and default TOML comments
- [ ] Implement scrutiny evaluator with built-in rules and change types
- [ ] Add five express record kinds, builders, and store accessors
- [ ] Implement `review express admit|confirm|escalate` with restore-to-base escalation
- [ ] Add express seal guard to `run complete`
- [ ] Add express verdict validation domain and route derivation
- [ ] Add unit and integration tests above

---

## Phase 3: Express templates and render integration

**Completion gate:**
- The two new templates are registered, and the intake template proposes a route and writes `Intake run:`.
- `author-express-fix` renders only after admission.
- `reviewer-express` render and invoke both prepare the express context, refuse uncleared scrutiny, and append the identical context.
- `protocol validate reviewer --phase express --record` records the express review.
- An echo-provider end-to-end run reaches a sealed issue run.
- `bun test test/unit/templates test/unit/skills/implementation-review-governance.test.ts` passes.

### 3.1 `author-issue-intake.md` (version 1 -> 2)

The route proposal fields and rules from Design Decisions. Replace `Planning run: {{run_id}}` with `Intake run: {{run_id}}`. State that the route is a proposal, that size alone never decides it, and that operator notes requesting express are recorded but do not bypass anticipated `escalate` rules. Keep all plan 217 brief sections, markers, write-once rules, and forbidden writes.

### 3.2 `author-express-fix.md` (new, version 1)

- Variables: `[brief_path, run_id, review_path, user_notes]`, with `review_path` and `user_notes` defaulting to `""`.
- Step name: `author:express-fix`.
- The body says to:
  - read the brief at its committed revision;
  - make the smallest change that satisfies every `ACn`;
  - add or adjust a test whenever behavior changes;
  - never edit the brief, its `source/` files, the configured skeletons, or `.5x/`.
- It forbids GitHub writes.
- When `review_path` is set, the author addresses that review's latest addendum.
- Commit with `5x commit --run {{run_id}} --phase express`, then finish with `5x protocol emit author --complete --commit <hash>`.
- If the change proves non-trivial, needs a design decision, or would touch areas listed in the brief's `Anticipated scrutiny`, the author stops without committing further code and returns `needs_human` with a reason that begins `escalate:`.
- Reuse the shared non-interactive and raw-JSON completion wording from `author-generate-plan.md`.

### 3.3 `reviewer-express.md` (new, version 1)

- Variables: `[brief_path, review_path, review_template_path, run_id]`.
- Step name: `reviewer:express`.
- The appended express context is the sole authority for the range: base, reviewed commit, full-diff command, and scrutiny report.
- Review the whole cumulative diff against each `ACn` (verbatim from the pinned brief) and the usual correctness, security, and test dimensions.
- Judge whether the change is genuinely suitable for express. Any need for a design decision, scope beyond the brief, or a risk the scrutiny rules missed is reported as an item with `scopeClass: plan_defect`.
- Every other item uses `implementation_defect`.
- `ready` means every `ACn` is satisfied with evidence; `ready_with_corrections` is not an approval.
- Write the review to `review_path`. Re-review appends an addendum.

### 3.4 Registration, guards, appended context

- `src/templates/loader.ts`: register both templates and their step-name fallbacks.
- `src/commands/template.handler.ts` / `invoke.handler.ts`:
  - the `author-express-fix` admission guard;
  - `reviewer-express` context preparation (records `express-review-context`), scrutiny refusal, and the appended context block;
  - `author-generate-plan` accepts briefs whose `Intake run:` names a sealed issue run of the same slug.

### 3.5 Tests

- Unit: render with scalar variables; the guards; frontmatter and step names; intake contains the route fields and `Intake run:` and no longer writes `Planning run:`; registry count +2; stale-override warning for each new template.
- Parity (`implementation-review-governance.test.ts` pattern): native render and invoke produce the same `reviewer-express` body and appended context.
- Integration (`test/integration/commands/express-flow.test.ts`, echo providers): issue run init, then intake record, admit, fix, quality, review `ready`, and seal succeed. A `structural` hit stops review until it is confirmed. A `dependencies` hit stops review until it is escalated.

- [ ] Update `author-issue-intake.md` (route proposal, `Intake run:`) and bump version
- [ ] Add `author-express-fix.md` and `reviewer-express.md`
- [ ] Register templates and step names
- [ ] Add render guards and express review context preparation with parity
- [ ] Accept `Intake run:` briefs in `author-generate-plan` handling
- [ ] Add unit, parity, and end-to-end integration tests above

---

## Phase 4: Skill route selection, express steps, and delivery

**Completion gate:**
- The skill renders for all four author/reviewer native/invoke combinations with only the correct delegation branch.
- It contains brief-keyed intake, route selection for both admission modes, the express steps, escalation, the express PR marker, express delivery identity, the standard-route intake-base check, and the legacy-brief path.
- The resume matrix and recipe fixtures cover the new rows.
- `bun test test/unit/skills test/integration/issue-resolution-recipes.test.ts` passes.

### 4.1 `src/skills/base/5x-issue-resolution/SKILL.tmpl.md`

- **Step 1 (new associations)**:
  - allocate names as today;
  - run `5x run init --brief <brief path> --worktree` (export `ISSUE_RUN`);
  - delegate intake recorded as `author:issue-intake --phase plan`.

  For existing associations, an `Intake run:` brief restores its issue run, and a `Planning run:` brief uses the unchanged legacy recipe.
- **Step 1b Route selection**:
  - Read `Route:`, the rationale, the expected change, and anticipated scrutiny.
  - Express is offered only when the brief proposes it, the mode is not off, express is enabled, and the brief is not legacy.
  - With `admission = confirm`, present the proposal and ask the operator.
  - With `auto`, admit and report the choice. Anticipated scrutiny of any kind falls back to `confirm`.
  - An operator request for the full workflow selects standard.
  - Standard: `5x run complete --run $ISSUE_RUN`, then plan 217 Step 2 onward, unchanged.
- **Express steps E1-E4**:
  - E1: admit.
  - E2: delegate `author-express-fix` (native Task or invoke), then `5x phase finish --phase express --no-phase-checklist-validate` (quality, then protocol record).
  - E3: delegate `reviewer-express`. Handle `EXPRESS_CONFIRMATION_REQUIRED` by asking the operator. Handle `EXPRESS_ESCALATION_REQUIRED` by escalating, or by an operator override only when the operator gives it explicitly.
  - E4: route `complete` leads to `5x run complete`; `author_revision` re-enters E2 with `review_path`, within `maxReviewIterations`; `escalate`, an author `escalate:` reason, the iteration limit, or an operator request leads to `review express escalate`, seal, and the standard route with `user_notes` naming the escalation.
- **Step 4 (express)**: the express PR marker and body fields (brief, issue run, reviewed head, base, per-criterion evidence, scrutiny decisions).
- **Step 5 (express)**: the `express-interval` recipe from the issue run's `budget.jsonl`, then the same classification, receipt preflight, and closure branches.
- **Standard on new associations**: add the intake-base check to Delivery identity.
- **Resume classification** adds these rows:
  - issue run active with no admission leads to intake or route selection;
  - admitted and not sealed reports `implementation_in_progress`;
  - escalated leads to planning;
  - a sealed express run with no PR leads to PR preparation.
- **Outcome vocabulary** is unchanged.
- **Discovery validation (3)** also accepts a brief with runs (`5x run list --brief`).
- **Gotchas**: express is not a governance bypass; never override an `escalate` rule without an explicit operator instruction; never move from standard back to express.

### 4.2 Tests and fixtures

- Update `test/unit/skills/issue-resolution-skill.test.ts`: the express markers, commands, and both admission-mode texts appear in each delegation context.
- Resume matrix: add rows for express proposed with confirm mode, auto admission, operator-requested express with an escalate rule anticipated, confirmation required at review, escalation from each source, the iteration limit, a sealed express run awaiting PR, an express PR merged, an escalated attempt not restored (delivery stops), and a legacy `Planning run:` brief.
- Recipe fixtures (`test/integration/issue-resolution-recipes.test.ts`): the express interval accepted on a clean history; code after `R` uncovered; a brief change after `BASE` uncovered; the standard intake-base check failing on an unrestored attempt; discovery accepting an issue-run brief with no plan file.

- [ ] Rewrite Step 1 for brief-keyed intake with the legacy path retained
- [ ] Add route selection for confirm/auto/operator-request and the standard handoff
- [ ] Add express steps E1-E4 with native/invoke branches and escalation
- [ ] Add express PR marker, express delivery identity recipe, and standard intake-base check
- [ ] Extend discovery validation and resume classification
- [ ] Add skill render assertions, resume-matrix rows, and recipe fixtures above

---

## Phase 5: Install, upgrade, documentation, and verification

**Completion gate:**
- Effective installed assets carry the express workflow for OpenCode, Cursor, and universal.
- `init --install-templates` scaffolds both new templates, and stale overrides warn.
- The docs describe express, scrutiny configuration, and escalation.
- The smoke matrix lists the new rows with run or pending status.
- The focused asset suite, lint, typecheck, and the full test suite pass.

### 5.1 Tests

`test/integration/commands/upgrade.test.ts`:
- a fresh install has the updated skill with the express marker;
- `harness sync` restores it;
- `--install-templates --force` writes `author-express-fix.md` and `reviewer-express.md`;
- a lower-version `author-issue-intake.md` override warns;
- in mixed mode (author invoke, reviewer native), the installed skill has only the matching branches.

### 5.2 Documentation

- `docs/getting-started.md`: an "Express route" subsection with the trigger phrases, both admission modes, the scrutiny categories, escalation, and that size is never a limit.
- `docs/configuration.md`: `[issues.express]` and the built-in rule table.
- `docs/cli-reference.md`: `run init|list|state --brief` and `review express admit|confirm|escalate`.
- `docs/issue-resolution-smoke.md`: rows for these scenarios:
  - a doc-only fix through express;
  - a default-value change through express;
  - a dependency bump escalated by scrutiny;
  - a file deletion requiring confirmation;
  - reviewer escalation with `plan_defect`;
  - author `escalate:` mid-fix;
  - auto admission;
  - an express PR merged and closed;
  - a legacy brief resumed.
- `CHANGELOG.md`: Added entry.

### 5.3 Final verification

Run:
- `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts`;
- `bun test test/unit test/integration/commands/run-brief.test.ts test/integration/commands/review-express.test.ts test/integration/commands/express-flow.test.ts`;
- `bun run lint`, `bun run typecheck`, and `bun run test`.

From a fresh temp project install (OpenCode and Cursor), diff the installed skill and templates against this contract. Confirm that `git diff main -- src/parsers src/plan-schema` is empty.

- [ ] Add install/sync/override/mixed-mode upgrade tests
- [ ] Update getting-started, configuration, CLI reference, smoke matrix, and CHANGELOG
- [ ] Run the focused asset suite, lint, typecheck, and full test suite; fix regressions
- [ ] Verify effective installed assets and the empty parser/plan-schema diff

---

## Files Touched

| File | Change |
|------|--------|
| `src/db/schema.ts`, `src/db/operations-v1.ts` | Migration 13, `subject_kind` (W1) |
| `src/control-plane/record-types.ts`, `src/control-plane/record-layout.ts` | Optional `subject_kind` in `run.json` (W1) |
| `src/records/backfill.ts`, `src/records/index-rebuild.ts`, `src/doctor/checks/records.ts` | Carry subject kind and subject slug (W1) |
| `src/paths.ts`, `src/git.ts` | `issuesDirFor`, `subjectSlugFromPath`, branch helpers (W1) |
| `src/commands/run-v1.ts`, `src/commands/run-v1.handler.ts` | `--brief`, validation, envelopes, guards, express seal guard (W1, W2) |
| `src/commands/plan-v1.handler.ts`, `src/commands/phase.handler.ts` | `RUN_SUBJECT_NOT_PLAN` guards (W1) |
| `src/config.ts`, `src/config-registry.ts`, `src/templates/5x.default.toml` | `issues.express` configuration (W2) |
| `src/review-governance/express.ts` | Scrutiny evaluator and built-in rules (W2) |
| `src/review-budget/record-lines.ts`, `src/review-governance/store.ts` | Express record kinds and accessors (W2) |
| `src/commands/review.ts`, `src/commands/express.handler.ts` | `review express admit/confirm/escalate` (W2) |
| `src/protocol.ts` | Express validation domain and route derivation (W2) |
| `src/templates/author-issue-intake.md` | Route proposal, `Intake run:`; version 2 (W3) |
| `src/templates/author-express-fix.md`, `src/templates/reviewer-express.md` | New templates (W3) |
| `src/templates/loader.ts` | Register templates and step names (W3) |
| `src/commands/template.handler.ts`, `src/commands/invoke.handler.ts` | Express guards and appended context (W3) |
| `src/skills/base/5x-issue-resolution/SKILL.tmpl.md` | Route selection, express steps, delivery (W4) |
| `docs/getting-started.md`, `docs/configuration.md`, `docs/cli-reference.md`, `docs/issue-resolution-smoke.md`, `CHANGELOG.md` | Documentation (W5) |
| `test/unit/db/*`, `test/unit/utils/*`, `test/unit/commands/*` | Migration, slug, record, guard tests |
| `test/unit/review-governance/express.test.ts` | Evaluator, records, domain |
| `test/unit/templates/*`, `test/unit/skills/*` | Templates, parity, skill renders, resume matrix |
| `test/integration/commands/run-brief.test.ts`, `review-express.test.ts`, `express-flow.test.ts`, `upgrade.test.ts` | CLI behavior, end to end, install |
| `test/integration/issue-resolution-recipes.test.ts`, `test/fixtures/issue-resolution/*` | Express delivery and discovery recipes |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | slug, migration, `run.json` | Existing plan slugs unchanged; brief slug equals reserved plan slug; compatible decode |
| Unit | `express.test.ts` | Every built-in rule and change type, overrides, confirmation binding, route derivation, express verdict domain |
| Unit | templates and skills | Guards, route fields, registry, parity, four role-mode skill renders, resume matrix |
| Integration | `run-brief.test.ts` | Issue run lifecycle, worktree sharing with the later plan run, plan-only guards |
| Integration | `review-express.test.ts` | Admission checks, restore-to-base escalation, seal guard, mode off refusal |
| Integration | `express-flow.test.ts` | Echo-provider express run end to end, plus confirmation and escalation stops |
| Integration | recipe fixtures | Express interval, uncovered code, unrestored escalation, discovery of issue-run briefs |
| Integration | `upgrade.test.ts` | Install, sync, `--install-templates`, stale overrides, mixed mode |
| Manual | `docs/issue-resolution-smoke.md` | Agent judgment on routing, triviality, and escalation; unrun rows reported pending |

Edge cases:
- a brief path outside the issues shape;
- an issue run initialized twice for the same brief;
- the scrutiny config changed between admission and review;
- a confirmation followed by a new matching path;
- escalation with a dirty worktree, which must refuse rather than discard work;
- an express attempt deleting a file and then escalating (the restore re-adds it);
- a legacy brief with `Planning run:`;
- governance mode changed to `off` mid-run.

---

## Not In Scope

- **Size thresholds of any kind**: an explicit operator decision.
- **Express without intake, or express outside `5x-issue-resolution`**: express is an issue route; ad hoc quick changes without an issue are a separate question.
- **Unreviewed express**, the governance `off` path, or a correction shortcut without re-review.
- **Renaming `plan_path`** in DB, records, or envelopes.
- **Plan parser, plan schema, or plan template changes**: verified by an empty diff.
- **Moving legacy plan 217 associations onto issue runs**: they finish on the standard route.
- **Auto-merge, release automation, or closure behavior changes**: unchanged from plan 217.
- **Learning scrutiny rules from history**, and per-language rule packs beyond the built-in table.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Run subject kind and brief-keyed runs | 2 days |
| 2 | Express governance and scrutiny | 2-3 days |
| 3 | Templates and render integration | 1-2 days |
| 4 | Skill and recipe fixtures | 2 days |
| 5 | Install, docs, verification | 1 day |
| **Total** | | **8-10 days** |

---

## Provenance

Follows [plan 217](217-explicit-issue-resolution-plan.md) and [Issue-driven resolution](../../v2/210-issue-resolution.md). The design doc's §5 rule, "do not bypass planning or review", is deliberately narrowed: express bypasses planning, never review. Operator decisions (November 6, 2026): auto or operator-confirmed admission with `confirm` as the default; runs keyed by the brief rather than a stub plan; scrutiny categories rather than size limits; a plan drafted directly with no plan input.

<!-- 5x:contract:end -->

## Revision History

### v1.0 (November 6, 2026)

Initial draft.
