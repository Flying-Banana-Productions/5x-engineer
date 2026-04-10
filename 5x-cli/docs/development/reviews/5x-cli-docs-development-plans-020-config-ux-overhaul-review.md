# Review: Config UX Overhaul

**Review type:** plan `docs/development/plans/020-config-ux-overhaul.md`
**Scope:** Staff review of config UX overhaul plan, referenced config/init/upgrade implementation, and harness/skill integration points
**Reviewer:** Staff engineer
**Local verification:** Not run (plan review only)

## Summary

Strong direction overall: deriving config metadata from the schema, making `config show` self-describing, and removing the init-time boilerplate config all fit the current architecture. Main blocker: the write-path design does not define what happens when the active config is still `5x.config.js` / `.mjs`, so the proposed `config set/unset/add/remove` flow can silently create a new `5x.toml` beside an existing JS config and change precedence without an explicit product decision.

**Readiness:** Not ready — one blocking behavior choice is unresolved, plus several mechanical plan contradictions need correction before implementation.

## Strengths

- Reuses the real sources of truth already in the codebase: `FiveXConfigSchema` for config shape/defaults and `resolveLayeredConfig()` for layered resolution.
- The provenance design is appropriately lightweight. Returning local overlay paths/raws is much safer than instrumenting `deepMerge()` for per-key source tracking.
- The init simplification is directionally correct: current `initScaffold()` still writes a large template config, while the runtime already has schema defaults and layered resolution.

## Production Readiness Blockers

### P0.1 — JS-config mutation semantics are unresolved

**Risk:** The plan explicitly keeps `5x.config.js` / `.mjs` supported for reads, but the proposed write path only targets `5x.toml` discovery/creation. In a repo that still uses JS config, `5x config set` would create a new TOML file, change config precedence, and split the source of truth without warning. That is a product/UX decision, not a mechanical detail.

**Requirement:** Define one explicit behavior for write commands when the active config source is JS/MJS: either reject with a migration hint, intentionally create TOML and document that this migrates precedence, or add JS mutation support. The plan must state the rule, error/UX behavior, and tests.

**Action:** `human_required`

## High Priority (P1)

### P1.1 — Record-key validation conflicts with dotted record writes

Phase 1 says the registry should emit `author.harnessModels` as a single `record` entry. Phase 4 then says `config set` must validate keys against that registry, reject unknown keys, and also support `author.harnessModels.opencode` via dotted notation. As written, strict registry validation would reject the exact record-write form the plan requires. Add an explicit rule that descendants of a registered `record` key are valid write targets and inherit scalar coercion from the record value type.

**Action:** `auto_fix`

### P1.2 — `--sub-project-path=.` semantics contradict the path-resolution rules

The design section says sub-project paths resolve relative to the control-plane root, but the same plan says `5x init --sub-project-path=.` should work when already in the target subdirectory and the tests assert that behavior. Those cannot both be true. Update the plan so path resolution semantics match the example/test contract.

**Action:** `auto_fix`

### P1.3 — `config show` default values are underspecified for path keys

Runtime config normalizes `paths.*` to absolute paths in `resolveLayeredConfig()`, while the registry defaults come from schema literals like `"docs/development"`. The plan then asks text mode to compare current value vs default and dim matching defaults. That comparison will be wrong for path keys unless defaults are normalized into the same runtime form. Specify whether displayed defaults are schema literals or effective resolved defaults, and keep comparison/rendering consistent.

**Action:** `auto_fix`

## Medium Priority (P2)

- The Goals section still says write commands default their target to the control-plane root, while the revised design/Phase 4 logic defaults `--context` to cwd. Align the top-level contract language with the actual intended behavior. **Action:** `auto_fix`
- Phase 7's proposed test (`agent can parse ... and produce the correct command`) reads like an LLM-behavior assertion, but the repo's current skill tests are static content/loader tests. Reframe that phase around deterministic skill-content or installer coverage so the completion gate stays objectively testable. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Define write-command behavior when the active config source is `5x.config.js` / `.mjs`.

**P1 recommended**
- [ ] Allow dotted descendants under registry `record` keys (for `harnessModels` and similar dynamic maps).
- [ ] Resolve the `--sub-project-path=.` contract so examples, algorithm, and tests agree.
- [ ] Specify how `config show` computes/displays defaults for path-valued keys.
- [ ] Align remaining stale wording around `--context` defaults and Phase 7 testability.
