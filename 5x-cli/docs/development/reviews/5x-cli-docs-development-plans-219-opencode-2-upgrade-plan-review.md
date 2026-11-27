# Review: OpenCode 2.x Upgrade

**Review type:** `docs/development/plans/219-opencode-2-upgrade-plan.md`
**Scope:** Initial schema-1 contract review, provider transport, harness assets, tests, and delivery evidence
**Reviewer:** Staff engineer
**Local verification:** Inspected implementation/imports and official V2 migration, client, agent, and OpenAPI documentation; `opencode --version` reports `v2.4.2`; reproduced the proposed source extractor's nested-object and string-brace failures with `bun -e`. Implementation tests were not run: this review changes no implementation.

## Review Context

- Phase / review kind: plan; initial material pass
- Reviewed plan commit: `fc5f949c`
- Binding / review context: `run_a9914ec93486`; enforced budget; governing baseline 18; no prior findings
- Only contract content outside notes was judged. No additional material requirement was found in the noncontract revision history.

## Summary

The private-server decision and migration scope are sound. Six mechanical corrections are required before execution: the first phase cannot satisfy its typecheck gate; native delegation needs asynchronous result handling, not just renamed parameters; and result recovery, extraction, and external-mode evidence have concrete gaps.

**Readiness:** Not ready — substantive protocol corrections require another review, but no new operator policy decision is needed.

## Strengths

- Keeps managed invocations isolated from the operator's background service and passwords out of committed configuration.
- Recognizes live-only subscriptions, prompt admission versus completion, structured-output removal, and native frontmatter migration.
- Includes effective installed-asset checks, native/invoke parity, four delegation modes, and Cursor render compatibility.
- Deletes an unreferenced legacy path rather than rebuilding an unused integration.

## High Priority (P1)

### R1 — Remove SDK-dependent dead modules before the Phase 1 typecheck gate

**Classification:** acceptance_required; auto_fix

**Risk:** Phase 1 removes `@opencode-ai/sdk` from both dependency files and requires `bun run typecheck`, but Phase 2 alone deletes modules and tests still importing that package. `tsconfig.json` includes all `src`, `test`, and `packages` files. The first phase cannot pass independently.

**Requirement:** Put deletion of the legacy SDK importers before the dependency-removal/typecheck completion gate.

**Evidence / correction:** Plan lines 215–218 and 348–359 conflict. Remaining imports are in `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/utils/event-router.ts`, and their TUI tests. Move the already accepted dead-path deletion ahead of the provider port, or into its phase; update the debt target phase and coverage references consistently. No new implementation scope is necessary.

**Budget evidence:** effortDelta 0; architectureDelta 0; confidence high. Prevents an unsatisfiable phase completion gate; lowest-cost correction is reordering existing work.

### R2 — Specify background native delegation and update the orchestrator's continuation instructions

**Classification:** acceptance_required; auto_fix

**Risk:** Renaming Task to subagent leaves synchronous examples that assign the launch result to `RESULT` and immediately validate it. V2 subagents always run in the background: launch returns a session identity, and the parent's completion report arrives later. Validating the launch acknowledgment instead of the child verdict fails or advances the wrong workflow step.

**Requirement:** OpenCode-native examples must separate launch acknowledgment/sessionID from the later completed author/reviewer JSON, correlate reports to the delegated step, and validate/record only completed output. Continuations must use the saved child sessionID. Cursor output must remain unchanged.

**Evidence / correction:** `src/skills/base/5x/SKILL.tmpl.md:180–200` and `5x-plan-review/SKILL.tmpl.md:154–165` directly consume the tool result. The official V2 Agents documentation explicitly says subagents always run in the background and report each time they go idle. Phase 4 currently specifies token substitution only. Also, `src/harnesses/opencode/5x-orchestrator.md:73,83,88` hard-codes `task_id`; Phase 4's agent-body instruction only replaces “Task tool,” so these continuation instructions survive the proposed changes.

Add harness-specific lifecycle wording/examples through the existing rendering mechanism, update all OpenCode orchestrator continuation references, and test launch-versus-completion separation plus continuation in the four delegation modes. Include one effective installed native delegation/continuation exercise, not only agent listing and keyword assertions.

**Budget evidence:** effortDelta 2; architectureDelta 0; confidence high. Prevents invalid premature protocol recording and broken reviewer reuse; lowest-cost correction is OpenCode-specific lifecycle rendering using existing mechanisms. Reviewer verification required.

### R3 — Make polling recovery preserve terminal failure semantics and avoid client/server clock comparisons

**Classification:** acceptance_required; auto_fix

**Risk:** The prescribed fallback accepts any set `outcome`, then reads text and usage. After SSE loss, `failed` or `interrupted` can therefore become a successful `done` (or even trigger a summary prompt). Its `time.idle >= promptStart` condition also compares a remote server timestamp to a client timestamp, so clock skew can cause premature completion or a timeout after successful execution.

**Requirement:** Polling must establish completion of the admitted prompt using server-side progress/message evidence, reject stale prior outcomes, and apply the same succeeded/failed/interrupted handling as the streamed path. It must remain bounded and cancellable.

**Evidence / correction:** Plan lines 105–108 specify the fallback condition; lines 110–112 specify failures only through execution events. The V2 `Session.Info.outcome` schema explicitly includes `succeeded`, `failed`, and `interrupted`. Replace the local-clock comparison with evidence tied to the prompt admission and server-side baseline; centralize terminal-outcome handling. Add scripted fallback cases for all outcomes, stale prior idle state, remote clock skew, timeout, and cancellation.

**Budget evidence:** effortDelta 1; architectureDelta 0; confidence high. Prevents false successful results and hangs in accepted external mode; lowest-cost correction reuses the existing turn loop and terminal handler. Reviewer verification required.

### R4 — Recover turn text when compaction removes the prompt from active context

**Classification:** acceptance_required; auto_fix

**Risk:** `session.context` is not a durable transcript. A long implementation turn can compact after prompt admission, removing the prompt ID that the plan uses as its extraction boundary. The specified algorithm then cannot reliably locate the turn, and may return empty, incomplete, or unrelated text.

**Requirement:** Extract the admitted turn's reply independently of whether its user message remains in active context.

**Evidence / correction:** Plan lines 107 and 319 prescribe assistant entries after the prompt ID in `session.context`. The official OpenAPI describes `session.context` as “all messages after the last compaction,” while `session.message.list` provides paginated durable messages. Keep the fast path if desired, but specify a durable-message fallback anchored to the admitted prompt, with pagination and an explicit missing-boundary error rather than silently selecting all context. Test a compaction that removes the prompt and a reply spanning more than one message page.

**Budget evidence:** effortDelta 1; architectureDelta 0; confidence high. Prevents loss of the final invocation response during normal long-running work; lowest-cost correction adds durable transcript recovery within the existing provider. Reviewer verification required.

### R5 — Do not port the Cursor extractor's nested-object and string-brace bugs

**Classification:** acceptance_required; auto_fix

**Risk:** The required trailing-object parser can return an inner object instead of the author/reviewer result, or reject valid JSON containing braces in strings. Because the caller validates the extracted value, this turns valid responses into failed invocations without triggering corrective extraction retries.

**Requirement:** The new OpenCode extractor must select complete top-level JSON objects and respect JSON strings and escapes. Leave the Cursor package unchanged as scoped.

**Evidence / correction:** The existing `packages/provider-cursor-agent/src/structured.ts` walks backward from every opening brace and counts braces without string state. A direct reproduction gives:

- `Here is the result:\n{"result":"complete","metadata":{"commit":"abc"}}` → `{"commit":"abc"}`.
- `Here is the result:\n{"result":"complete","reason":"a } brace"}` → extraction failure.

Plan lines 118 and 289 require porting/matching that extractor, while line 326 expects string-brace correctness. Qualify reuse to preserve extraction precedence, not the defective scanning algorithm. Scan complete top-level candidates with quote/escape awareness and add prose-prefixed nested-object, escaped-quote, string-brace, multiple-object, and array-with-object rejection cases.

**Budget evidence:** effortDelta 1; architectureDelta 0; confidence high. Prevents discarding a valid structured author/reviewer response; lowest-cost correction is a small scanner in the already planned new module. Reviewer verification required.

### R6 — Make external-mode acceptance and factory verification evidence executable

**Classification:** acceptance_required; auto_fix

**Risk:** AC1 promises real managed and external operation, but the live test only creates a managed provider, and the manual invocation never configures an external URL. In addition, Phase 1 requires external factory verification while retaining a construction-only, network-free bundled-provider test.

**Requirement:** Explicitly exercise authenticated external mode and test the factory's verification/cleanup behavior without real network I/O in unit tests.

**Evidence / correction:** Plan lines 206, 260, 327–331, and 493–497 leave this mismatch. The existing bundled test at `test/unit/providers/plugin-loading.test.ts:463–490` calls `createProvider` with `http://127.0.0.1:1`; after the planned factory change this necessarily attempts verification, and its catch branch can mask failures.

Use an injected fake client/fetch or factory seam for healthy, unauthorized, and verification-failure cleanup cases; keep construction-only assertions on `createExternal` itself. Extend the opt-in live/manual exercise to create an explicitly authenticated external provider against a test-owned server, run streaming and structured output, and prove closing the external provider does not terminate that server. Put environment-mutation or real-process tests in the integration tier.

**Budget evidence:** effortDelta 1; architectureDelta 0; confidence high. Prevents shipping an unverified accepted external path and a misleading factory regression test; lowest-cost correction extends the existing fake-client and opt-in live fixtures.

## Delivery Budget Assessment

- Independent initial-scope effort estimate: **20**, medium confidence. A new major transport/concurrency migration is the dominant uncertainty; native asynchronous delegation and installed workflow compatibility constitute cross-subsystem work beyond simple renaming. Extraction, diagnosis, dead-code removal, and release documentation are comparatively bounded. This estimate was based on those implementation boundaries, not adopted from the ledger total.
- Stable W1–W6 IDs and coverage exist. Architecture scores are explainable. R1 requires the DC0 phase target to follow the reordered deletion, not a new debt claim.
- **DC0: eligible; intrinsic.** Removing the old SDK makes handling its dead importers unavoidable. The persisted before/after states and minimal port alternative are concrete; deleting unused modules is genuinely simpler than keeping and porting their controller/permission/event interfaces. The target phase is explicit and the negative row has a complete claim.

## Asset-impact Check

- **Document skeletons:** Unaffected; no provider-specific document shape is introduced.
- **Agent prompts:** Runtime-rendered role prompts can remain transport-neutral; OpenCode harness agent-body continuation references need R2's correction.
- **Runtime-appended context / native-invoke parity:** Keep CLI ownership and existing parity tests; no new dynamic fact belongs in static assets.
- **Workflow skills:** Planned tool-name tokens are necessary but insufficient without R2's OpenCode background lifecycle.
- **Install / override / upgrade / sync:** Existing effective-installed checks and focused acceptance suite are appropriate; add the actual delegation exercise required by R2. Preserve user override resolution and Cursor output.

## Nonblocking follow-ups

- The explanatory version-gate paragraph calls the missing V1 route `/api/server`; the published V2 operation `server.info()` uses `/api/info`. The normative client call is correct; correct the explanatory path when revising.
- During implementation, include startup-timeout cleanup and continuous stdout/stderr draining in the private-server lifecycle tests. Successful `close()` coverage alone is not a substitute for failure-path resource handling.
- The proposed foreign-session mapper test needs a wrapper/session-filter assertion: the proposed pure mapper signature itself has no target session ID. Existing provider-level foreign-session coverage is the right place to enforce isolation.

These observations do not add structured items or authorize adjacent work.

## Readiness Checklist

- [ ] R1: dependency-removal gate can pass in phase order.
- [ ] R2: native background completion and session continuation are explicit and tested.
- [ ] R3: polling and streaming have equivalent terminal semantics.
- [ ] R4: text extraction survives compaction.
- [ ] R5: nested/string-safe object extraction is specified.
- [ ] R6: real external mode and fake factory verification have concrete evidence.

## Addendum (November 27, 2026) — Closure review, iteration 2

**Reviewed range / context:** `3069786ef847bbccd80c97244dbb0273fee447f1..7748fefe95ed63c222ffef7ad9118af738f84c54`; `run_a9914ec93486`; enforced closure review of plan v1.2, including the substantive revision `3a922168` and ledger repair `7748fefe`.

**Verification:** Read the supplied diff first, retrieved the complete plan-only diff, and read the updated plan in full. Confirmed the working plan matches the committed endpoint and that no implementation files changed in the reviewed range. Rechecked the published V2 execution-event schemas retained from the initial review. This assesses the plan contract, not implementation completion; implementation tests were not run.

### Prior-finding outcomes

| Finding ID | Outcome | Evidence |
|---|---|---|
| R1 | addressed | Phase 1 now deletes legacy SDK importers and their tests before Phase 2 removes the dependency (lines 272–301). AC5, the timeline, and DC0's target phase are consistent. |
| R2 | addressed | Design lines 163–212 separate launch acknowledgment from correlated background completion and capture child sessionID. Phase 4 updates all native launch/capture sites, removes orchestrator task_id instructions, tests four delegation modes and Cursor byte identity, and requires an installed-orchestrator delegation/continuation exercise (lines 513–646). |
| R3 | partially_addressed | Server-only timestamps, stale-outcome rejection, shared settleTurn, cancellation, progress-sensitive inactivity timeout, and outcome-parity tests are now explicit (lines 103–125, 419–428). However, the polling completion predicate still requires an assistant message for every outcome, including failure/interruption before any assistant exists. |
| R4 | addressed | readTurnText now has a durable paginated session.message.list fallback, explicit missing-boundary failure, and compaction/multipage tests (lines 120, 373, 429–432). |
| R5 | addressed | The scanner is explicitly forward, top-level-only, and string/escape-aware; it distinguishes array nesting and includes the requested nested/string/escape/prose regressions while leaving Cursor unchanged (lines 128–138, 445–456). |
| R6 | addressed | The factory gains a per-call fake-constructor seam and healthy/unauthorized/cleanup tests; the masking catch is removed. Authenticated external live and manual checks explicitly verify streaming, structured output, password errors, and survival of the test-owned external server after provider close (lines 339–354, 438–468, 675–681). |

### What's Addressed

- All six finding identities remain mapped in the ledger: W3→R1, W5→R2, W7→R3/R4, W2→R5, and W8→R6. W1, W4, and W6 have no claimed finding address. No finding was silently dropped by the W1/W7/W8 split.
- Revision `7748fefe` splits the oversized provider row into valid work-item scores without changing its implementation obligations. The remaining R3 correction belongs to W7; its Addresses entry should remain until the predicate is corrected.
- The changed workflow continues to cover document skeletons, agent prompts, runtime-context parity, four-mode skills, override resolution, and effective installation/synchronization. The installed native delegation exercise closes the initial asset-verification gap.
- The initial nonblocking route-name, startup-cleanup/output-draining, and mapper-session-filter observations were incorporated.

### Remaining Concerns

#### R3 — Polling must settle failed/interrupted execution without requiring an assistant reply

**Classification:** acceptance_required; auto_fix

**Risk / concrete failure:** Design step 5 (lines 108–110) says completion requires both a new idle timestamp and `promptId` followed by at least one assistant message. Step 6 invokes settleTurn only after that predicate succeeds. An admitted prompt can fail during setup, before an assistant message is produced, or be interrupted before the first assistant response. If SSE ends before that terminal event arrives, the new server-side failed/interrupted outcome cannot pass step 5. The provider waits until its inactivity timeout and reports its own timeout instead of the actual terminal outcome. The shared terminal handler is therefore still unreachable for a valid failure path.

The published `session.execution.failed` event requires only sessionID and error; `session.execution.interrupted` requires only sessionID and reason. Neither promises an assistant-message boundary. A scripted fake returning a new server idle time and `outcome: "failed"` with the admitted user message but no assistant is consequently a necessary recovery case, not a malformed response.

**Requirement / lowest-cost correction:** Keep the admitted-prompt/new-server-idle evidence that excludes stale outcomes, but require an assistant reply only when recovering a successful result. A newly completed failed or interrupted outcome must reach settleTurn without an assistant prerequisite. Add explicit SSE-drop fixtures for failure and foreign interruption before the first assistant message, asserting prompt termination with the original outcome, no summary prompt, and no wait for the inactivity timeout.

**Remaining budget evidence:** effortDelta 1; architectureDelta 0; confidence high. This is a local condition/test correction inside the already planned turn loop, with no new abstraction or scope decision.

### Continued Credit Assessment

**DC0 remains eligible; intrinsic.** Its target changed from phase-2 to phase-1, so this closure re-assesses it rather than silently carrying the previous assessment. The same persisted before/after states and minimal-compliant alternative remain concrete: dependency removal intrinsically requires handling the unused SDK importers, and deleting their unused controller/permission/routing surfaces is simpler than porting them. The new phase target correctly places that deletion before dependency removal. No other new or changed author debt claim is present. No new baseline assessment is made.

### Nonblocking follow-ups

- The forward scanner's specified depth behavior may need recovery from unmatched bracket-like prose before a later valid JSON object. This is adjacent parser hardening beyond the admitted nested-object/string-brace correction, not an additional closure blocker.
- The factory seam's illustrative return type is the concrete OpenCodeProvider class, whose private members prevent a plain structural fake from satisfying it without a cast. Prefer a narrow internal provider shape or an explicit test cast during implementation; the seam's intended behavior and concurrency isolation are clear enough to implement.

These observations are excluded from structured items and do not authorize additional work.

### Updated readiness

**Ready with corrections:** R1, R2, R4, R5, and R6 are addressed in the plan. R3 needs one mechanical polling-predicate and regression-test correction. There are no new blocking finding IDs, no human policy decision, and no claim of implementation approval. Budget aggregation and workflow routing remain CLI-owned.
