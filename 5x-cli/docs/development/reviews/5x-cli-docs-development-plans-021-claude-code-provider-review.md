# Review: Claude Code Provider Plugin

**Review type:** `docs/development/plans/021-claude-code-provider.md`
**Scope:** Plan review for the external Claude Code provider plugin, provider/session design, config surface, and test strategy.
**Reviewer:** Staff engineer
**Local verification:** Source review of the plan plus related provider architecture/docs (`src/providers/types.ts`, `src/providers/factory.ts`, `src/providers/opencode.ts`, `packages/provider-sample/`, archived Claude Code adapter plans/reviews). No live Claude invocation run.

## Summary

The direction is good: an external `@5x-ai/provider-claude-code` plugin fits the existing provider factory and reuses the right abstractions. But the plan is not ready as written. It reintroduces a previously known Claude CLI argv failure mode without any prompt-size guard, and its session-state description is inconsistent enough that a literal implementation could break `resumeSession()` / `continuePhaseSessions`.

**Readiness:** not_ready - blocking correctness gaps remain in prompt delivery and resume semantics.

## Strengths

- Fits the current external-plugin architecture cleanly: `ProviderPlugin` + dynamic import + plugin-specific config passthrough already exist.
- Splits pure mapping logic from subprocess/session logic, which matches the repo's current provider testing style.
- Keeps the integration boundary realistic by driving the real `claude` CLI shape instead of inventing a fake SDK abstraction.

## Production Readiness Blockers

### P0.1 - Prompt delivery reintroduces the known Claude CLI argv-length failure mode

**Action:** `auto_fix`

**Risk:** The plan passes the full rendered prompt via `claude -p <prompt>` on every invocation but does not include the existing Claude-specific safeguard for command-line length. Large plan/review prompts can fail before Claude starts (`E2BIG` / OS argv limits), and the implementation would regress a failure mode this codebase already documented and previously hardened.

**Requirement:** Add an explicit byte-based prompt-size guard and test coverage for it in the provider/session plan. Also carry forward the documented limitation that prompt text is exposed on argv, so prompts must not assume secrecy.

**Evidence:**
- New plan always uses `claude -p`: `docs/development/plans/021-claude-code-provider.md:18-20`, `:55-63`, `:202-205`
- Existing archived Claude adapter design already called out the need for `MAX_PROMPT_LENGTH` and argv exposure docs: `docs/archive/plans/001-impl-5x-cli.md:751-757`, `:773-779`
- Prior Staff review treated this as required hardening for Claude invocation: `docs/development/reviews/2026-02-16-5x-cli-phase-2-agent-adapters-review.md:64-69`, `:117-125`, `:144-145`

## High Priority (P1)

### P1.1 - Resume semantics are internally inconsistent between the design notes and phase tasks

**Action:** `auto_fix`

The plan mixes two incompatible models for session state. DD3 says a session tracks `hasRun` and the first `run()` uses `--session-id`, but `resumeSession()` in Phase 2.3 also says it creates a resumed session object. A provider-resumed session must use `--resume` on its first invocation, not `--session-id`, or `continuePhaseSessions` will silently fork a new Claude session instead of continuing the existing one.

**Recommendation:** Make the state model explicit in the plan: `startSession()` creates a session whose first invocation uses `--session-id`, while `resumeSession(existingId)` creates a session whose first invocation already uses `--resume`. Document the exact constructor/state fields needed to encode that distinction and test both paths.

**Evidence:**
- DD3 says first run uses `--session-id`, subsequent runs use `--resume`: `docs/development/plans/021-claude-code-provider.md:82-88`
- Phase 1 arg builder already models an `isResume` branch: `docs/development/plans/021-claude-code-provider.md:199-205`
- Phase 2 session/provider tasks still describe a single `hasRun` toggle plus `resumeSession(...): create session with isResume: true`: `docs/development/plans/021-claude-code-provider.md:258-280`, `:283-289`
- Current provider contract requires `resumeSession(sessionId, opts?)` to return a usable resumed session object: `src/providers/types.ts:15-30`

### P1.2 - The verification plan is too mock-heavy for a CLI contract this brittle

**Action:** `auto_fix`

The proposed integration test uses a bash stub for `claude`, which is useful, but the provider's correctness also depends on exact upstream CLI flags and event/result field names (`stream-json`, `--json-schema`, partial-message events, result payload shape). Without an env-gated live probe or documented minimum CLI capability check, upstream Claude changes can break the provider while the full planned test suite still passes.

**Recommendation:** Add one env-gated live smoke/schema probe that runs only when Claude is installed/configured, validating just the required subset of the JSON/NDJSON contract and the flags this provider depends on. Also document the minimum supported Claude CLI capability/version in the plan.

**Evidence:**
- Plan relies on specific Claude CLI flags/event names: `docs/development/plans/021-claude-code-provider.md:22-25`, `:67-75`, `:107-120`, `:205-207`
- Current Phase 3 verification is mock-script only plus manual smoke test: `docs/development/plans/021-claude-code-provider.md:309-339`
- Earlier Claude adapter work explicitly kept an env-gated live schema probe to catch upstream drift: `docs/archive/plans/001-impl-5x-cli.md:747`, `:805`, `:1576`; `docs/development/reviews/2026-02-16-5x-cli-phase-2-agent-adapters-review.md:27`, `:35`, `:70-75`

## Medium Priority (P2)

- **Action:** `auto_fix` - Fix the event-name mismatch in the mapping section so the plan consistently refers to Claude tool result payloads as `tool_result`, not both `tool_use_result` and `tool_result` (`docs/development/plans/021-claude-code-provider.md:115`, `:227`).

## Readiness Checklist

**P0 blockers**
- [ ] Add a byte-based prompt-length guard and explicit argv limitation coverage to the provider plan.

**P1 recommended**
- [ ] Clarify new-session vs resumed-session state so `resumeSession()` uses `--resume` on its first run.
- [ ] Add an env-gated live Claude contract probe (or equivalent capability check) in addition to mock-script integration tests.
