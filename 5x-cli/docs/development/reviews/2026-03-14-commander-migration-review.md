# Review: Commander Migration PRD (citty -> Commander.js)

**Review type:** `5x-cli/docs/020-commander-migration.prd.md`
**Scope:** CLI framework swap (citty -> commander), adapter rewrite, parsing/validation/help UX; contract + backwards compatibility
**Reviewer:** Principal PM + Staff engineer (CLI UX, API/contracts, reliability, maintainability)
**Local verification:** Not run (static review: PRD + code/test inspection)

**Implementation plan:** N/A
**Technical design:** `5x-cli/docs/v1/100-architecture.md`, `5x-cli/docs/development/archive/010-cli-composability.md`

## Summary

The PRD correctly identifies real UX/DX limitations of citty and targets the right seam: adapter-only framework migration with handler stability.

However, several key details are currently inconsistent with the *existing* CLI surface and contracts (flag compatibility, global pretty parsing, stdout envelope claims, and choice validation semantics). If implemented as written, this risks breaking integration tests and (more importantly) breaking existing automation/pipes that treat `5x` as a machine-consumable tool.

**Readiness:** Ready with corrections — fix P0s so migration preserves current CLI contracts while delivering the intended UX gains.

---

## Strengths

- **Right migration boundary:** Adapter/handler split is real in current code (`5x-cli/src/commands/*.handler.ts` have no `citty` imports), so a framework swap is feasible without business-logic churn.
- **Good problem framing:** The enumerated citty gaps map to real workarounds in code (`5x-cli/src/bin.ts`, `5x-cli/src/utils/parse-args.ts`).
- **Explicit constraints:** Calls out test pass gates, exit-code stability, and Bun standalone build (`bun build --compile`).
- **Help/UX ambition:** Rich per-command help + examples will materially improve human usability if kept accurate.

---

## Production readiness blockers

### P0.1 — Global `--pretty/--no-pretty` must keep “any position” behavior

**Risk:** Current tests and scripts pass `--pretty` after subcommands/args (e.g. `5x skills install project --pretty`). Commander commonly treats parent options as only-before-subcommand unless explicitly handled.

**Requirement:** Preserve the existing behavior: `--pretty/--no-pretty` must be accepted anywhere in argv and still reliably set formatting before output.

**Implementation guidance:** Either (a) keep the current pre-parse strip logic (works today; minimal risk) or (b) explicitly add the option to every leaf command (shared helper) and read via `optsWithGlobals()`.

---

### P0.2 — `--worktree-path` is not “internal”; decide on compat + deprecation

**Risk:** The PRD treats `--worktree-path` as hidden/internal, but it is a documented public flag today (`5x-cli/src/commands/run-v1.ts`) and is exercised by integration tests (`5x-cli/test/integration/commands/run-init-worktree.test.ts`). Removing it will be a breaking change for both tests and user automation.

**Requirement:** Either:
- Keep `--worktree-path <path>` as a supported alias (at least for one release) while adding `--worktree [path]`, or
- Explicitly mark this as a breaking change with a migration plan and update all tests/docs accordingly.

**Implementation guidance:** Prefer compatibility: support both flags, map both onto existing handler params (`worktree`/`worktreePath`), and optionally emit a stderr deprecation warning when `--worktree-path` is used.

---

### P0.3 — Help/output contract statements must match current stdout/stderr behavior

**Risk:** The PRD’s program-level help text asserts “All commands output JSON envelopes”, but several commands are intentionally human-readable or streaming:
- `5x init` and `5x upgrade` print human text to stdout (`5x-cli/src/commands/init.handler.ts`, `5x-cli/src/commands/upgrade.handler.ts`).
- `5x run watch` streams NDJSON or human text to stdout (`5x-cli/src/commands/run-v1.handler.ts`).

**Requirement:** Update help/footer copy (and any acceptance criteria) so it is truthful: “Most commands output JSON envelopes; exceptions: init/upgrade (human), run watch (streaming).”

**Implementation guidance:** Keep the current behaviors unless you are deliberately changing them (which would be out of scope here and would require a separate PRD).

---

### P0.4 — Commander API usage in PRD must be validated (or replaced)

**Risk:** The PRD references help grouping via `.optionsGroup()`, which is not part of core Commander’s commonly used API surface. If this API does not exist (or differs), implementation will stall or devolve into ad-hoc help formatting.

**Requirement:** Replace speculative API calls with a verified approach using actual Commander primitives (e.g., `configureHelp()`, `addHelpText()`, `addOption(new Option(...))`, custom help formatter).

**Implementation guidance:** Add a small spike section (or footnote) confirming the exact Commander version + supported help customization hooks intended for grouping.

---

### P0.5 — Choice validation must not break current accepted values and error-code contracts

**Risk:** The PRD proposes `.choices()` for some options/args. Today, some handlers intentionally accept broader inputs (e.g., `prompt confirm --default` accepts `yes/no/y/n/true/false` and tests cover `y`/`n`: `5x-cli/test/integration/commands/prompt.test.ts`). Framework-level `.choices(['yes','no'])` would break behavior.

**Requirement:** Ensure any framework-level validation matches current accepted values and preserves externally visible error codes where they are already relied upon.

**Implementation guidance:** For `prompt confirm`, either widen choices to match implementation or keep validation in the handler and use help text to document accepted synonyms.

---

## High priority (P1)

### P1.1 — Make “pipe composability” an explicit non-regression requirement

The PRD currently under-specifies pipe behavior, but the existing implementation depends heavily on stdin/envelope composition (`5x-cli/docs/development/archive/010-cli-composability.md`, `5x-cli/src/pipe.ts`, `5x-cli/src/commands/run-v1.handler.ts`). Add acceptance criteria covering:

- `5x run init ... | 5x invoke author ...` still works without requiring `--run`.
- `5x invoke ... | 5x run record` still works (step/run/result inferred), and stdin priority rules remain unchanged.

### P1.2 — Clarify parser-error UX vs JSON-envelope contract

Today, citty parser errors print usage text (stdout) + message (stderr) (`5x-cli/src/bin.ts`). The PRD suggests converting Commander parser errors into JSON envelopes.

Recommendation: decide explicitly:
- If the contract is “stdout is always JSON except explicit `--help` / streaming commands”, then route *all* parsing/validation errors into `{ ok:false, error }` on stdout, and put human help/suggestions on stderr.

---

## Medium priority (P2)

- **Help content maintenance:** If G3 is pursued (full curated help), add snapshot-style tests for `--help` output per command to prevent drift.
- **Breaking-change messaging:** If any flags are removed/renamed (e.g., `--worktree-path`), include release-notes text and a deprecation window.
- **Validation consistency:** Where Commander adds new coercion/validation (numbers, enums), ensure the same error codes and exit codes are preserved (or intentionally versioned) for automation stability.

---

## Readiness checklist

**P0 blockers**
- [ ] Global `--pretty/--no-pretty` works anywhere in argv (matches current tests + behavior)
- [ ] `--worktree-path` compatibility decision made and reflected in PRD + tests
- [ ] Help/footer copy reflects real stdout behaviors (JSON vs human vs streaming)
- [ ] Help grouping approach uses verified Commander APIs
- [ ] `.choices()` plan matches current accepted values (notably `prompt confirm --default`)

**P1 recommended**
- [ ] Add explicit non-regression acceptance criteria for pipe composition flows
- [ ] Decide/declare how parser errors map to JSON envelopes vs human help output
