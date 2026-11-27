# Review: OpenCode 2.x provider port (Phase 2)

**Review type:** Implementation commit `4f91b494f193dc62f62e852b1bab9bb6a2416e73`  
**Scope:** OpenCode provider, client dependency, event and structured-output adaptation, factory, and tests  
**Reviewer:** Staff engineer  
**Local verification:** `bun test test/unit/providers` (316 passed); `bun run typecheck` and `bun run build` passed; exact range `git diff --check` passed. `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts` on OpenCode v2.4.2 with the default model: 4 passed, 1 failed, no skips. Separate controlled live comparison and scripted-client probes below.

## Review Context

- Phase 2; initial material pass against approved v1.7 in enforced mode.
- Exact range: `fb7e33d4bd9020f4d638e7268ebb0dc6dd789b28..4f91b494f193dc62f62e852b1bab9bb6a2416e73`. Retrieved the full governing code diff separately from the plan's checkbox-only diff.
- Binding `d175e674-cbdd-4fff-90f3-93619ffe02fc`; source `run_b9df06a4d15d`; review context `b86de74b-8f69-4e47-a520-ae1dd3e6375f`; approved plan commit `013717dd9b44883897f65fb016a6d50a163efd82`. No prior finding outcomes, due claims, accepted-risk decisions, or operating restrictions were supplied.

## Summary

**Readiness: Not ready.** OpenCode v2.4.2 prevents the interactive question by withholding the tool, which the approved test expressly cannot count. The fallback's continuation assumption is also false on that version. Separately, an admission race can stream mixed output before reporting overlap.

The managed and authenticated external cases provide Phase 2 evidence for operator AC1 (including streamed tool/text, window usage, and structured output). The managed subprocess and its cleanup also support AC4. Version-gate and factory tests support AC2's Phase 2 portion, with an error diagnostic correction below. Phase 3 doctor and Phase 5 `5x invoke` evidence are not due here. Neither the operator's authorization for a controlled comparison nor the checked implementation boxes amend the live gate.

## Strengths

- The public Promise client is pinned exactly; the 1.x SDK dependency is removed.
- Both live provider paths streamed a shell turn with positive window usage and completed a structured run. The managed process was gone after close; the authenticated external server survived close, and the no-password case failed as expected.
- The fake-client suites cover delivery, durable settlement, exact-ID cleanup, and usage attribution without network dependencies. The streamed success window excludes a later execution in the tested case.

## High Priority (P1)

### P1.1 — Align the headless acceptance contract with OpenCode 2.4.2

**Classification:** `plan_defect`, `human_required`; design impact, no API, schema, dependency, subsystem, architecture, or phase-structure boundary change for the proposed controlled comparison. Estimated additional effort: 1; architecture delta: 0. Affects Phase 2 acceptance and reuse of the same test in Phase 5.

**Risk / requirement:** The no-skip completion gate cannot close at `MIN_OPENCODE_VERSION` on the observed, correct prevention path. Rerunning an ordinary settled turn is not evidence of denial. Treating a cancelled control form as proof of continued execution would also assert behavior the server does not provide.

**Evidence:** I reproduced the committed test's `inconclusive` result: the denied turn settled, calling `execute` rather than `question`. I separately ran the same prompt and model in two fresh sessions on one test-owned 2.4.2 server, varying only the `question` deny rule and assigning each prompt its own ID. With deny, there was no `question` attempt in the captured events and no form, and the execution succeeded. In the allow-only control, OpenCode started `question` and emitted the session's `form.created`. Cancelling that exact form emitted `session.tool.failed` (aborted; user dismissed the question), `session.step.failed` (step interrupted), and `session.execution.interrupted` (`shutdown`), not `execution.succeeded`. The author log has the same result. This supports prevention by making the tool unavailable in this test configuration, not a rejected observable tool call or a cancellation that lets the turn continue.

**Governing spans:** `Design Decisions` (headless live check and cancel-and-continue rule); `Phase 2: Provider port to \`@opencode/client\`` (completion gate and question task); `2.3 Turn loop and session (\`src/providers/opencode.ts\`)` (conditional form cancellation); `2.6 Tests` (success after form cancellation and the rule that absence of both a tool call and a form is inconclusive); `5.2 Final verification` (same live gate reused before release). The structured verdict quotes the operative text. The titles and summary rows in the work ledger, files-touched table, and test inventory should stay consistent if the terminology changes.

**Lowest-cost correction:** Approve/register a narrowly scoped design amendment before changing behavior or checking the two open tasks. Keep production `question` denial and the managed/external minimum-version gate. Use the same prompt, model, server/version, and isolated test context in the positive control and the denied provider session. The control must produce a matching question form (otherwise inconclusive); its cancellation is fixture cleanup, not a provider fallback pass. Require timely successful completion of the deny arm with no matching question call or form. Do not count a timeout, an arbitrary error, or an uncontrolled normal turn as prevention. Remove the unsupported continuation promise or define a separately verifiable terminal policy if forms can occur; do not weaken external ownership restrictions.

### P1.2 — Do not stream output after overlap is already known

**Classification:** `implementation_defect`, `auto_fix`; W7, W9; effort 1, architecture delta 0, no boundary change.

**Risk / requirement:** The prompt-ownership guarantee applies to streamed content as well as the final result. In a shared external session, previously detected foreign input can already have influenced the text, reasoning, or tool content streamed to the caller and logged by the CLI. A later ambiguous-result error cannot retract those events.

**Evidence:** `5x-cli/src/providers/opencode.ts:359–388` introduces the asynchronous `EventPump` queue; at `1136–1162`, `drive()` drains and yields a batch before acting on pending overlap. At `1285–1301` and `1331–1333`, a foreign delivery before our own sets `overlap` but not `contentClosed`; processing our own delivery then enables content mapping. In a scripted external-client probe, a lost admission response started polling. During its inbox read I buffered a foreign enqueue and delivery, our enqueue and delivery, a synthetic text delta, and terminal success. The reviewed code yielded the synthetic text **before** emitting the ambiguous result error, and did not return a result. The existing test for foreign delivery *after* our own covers the opposite order and does not catch this.

**Lowest-cost correction:** Handle a pending/admitting overlap before any later buffered delivery can enable streaming. Stop mapping content once overlap is known and use the existing exact-ID cleanup when needed. Add the buffered sequence regression: no mixed content or success/summary, no external interrupt, and use only the owned inbox ID for cancellation.

## Medium Priority (P2)

### P2.1 — Bound recovery work by the active turn deadline

**Classification:** `implementation_defect`, `auto_fix`; W7, W9; effort 1, architecture delta 0, no boundary change.

**Evidence / correction:** `opencode.ts:927–956, 964–993, 1194–1238, 1338–1361` only bounds individual requests, and the paginated path accumulates every remaining page even after the closing `idle` is available. A slow page or long durable history can overrun the reconciliation or inactivity limit before the driver gets control back. Also, `nextWakeDelay()` still includes an expired admission deadline after server evidence resolves admission; for a turn that continues running, this yields zero-delay wakeups. Pass the remaining applicable deadline through reads, stop scanning when the necessary boundary is found, and only schedule the admission deadline while it is relevant. Add delayed-page and lost-reply-but-still-running coverage.

### P2.2 — Distinguish an unavailable endpoint from an old server

**Classification:** `implementation_defect`, `auto_fix`; W1, W8; effort 1, architecture delta 0, no boundary change.

**Evidence / correction:** `opencode.ts:1685–1702` maps every non-transport `ClientError` to OpenCode 1.x. I passed a 503 from the test fetch seam and got `found 1.x` and `opencode upgrade --major`, although an upstream outage does not establish a version. Match the intended missing-route/legacy HTML signals; use the ordinary health-check error for other HTTP and decode failures. Keep the actual 1.x, old 2.x, and unauthorized version tests and cover an upstream 503.

## Nonblocking follow-ups

- The raw-event pump buffers all subscribed sessions while the turn is blocked on I/O or its consumer, and filters later. Filtering foreign sessions before enqueue and bounding backlog with an explicit recovery path would limit memory on a busy external server. No queue-pressure incident was observed in this pass.
- The dedicated external test fixture checks a startup deadline around an awaited reader read rather than bounding the read itself. Consider making its fixture startup bound independent of output arrival.

## Readiness Checklist

- [ ] Amend the question acceptance and fallback design, then pass the controlled no-skip live gate at the pinned minimum.
- [ ] Fix and verify buffered overlap suppression and owned cleanup.
- [ ] Address the bounded recovery and version diagnostic corrections and rerun the affected tests.

## Addendum (November 27, 2026) — Phase 2 implementation closure

**Reviewed range / context:** `4f91b494f193dc62f62e852b1bab9bb6a2416e73..aa99077eca2d6d7471e806b8d3fb40bc135bc2f2`, context `4b14075a-12fe-431a-95a2-f461117b94e5`; effective registered v1.9 (`amendment:9284200c43a9379afe49ff0d13d65fc0ec48fb249895d2143fd368b110da089e`), enforced. No credit claims are due.

### Prior-finding outcomes

| Finding ID | Outcome | Evidence |
|---|---|---|
| P1.2 | Addressed | `opencode.ts:1229–1255, 1325–1330, 1445–1449` stops the drain on pre-delivery overlap before later buffered events can enable stream output. Once overlap is known, the mapper suppresses content. The new lost-admission regression runs the original buffered ordering in external and managed mode: no mixed text or reasoning, no success or summary, only owned inbox cancellation, and no external interrupt. |
| P2.1 | Addressed | `opencode.ts:279–298, 895–936, 978–1054, 1311–1357, 1455–1528` limits transcript pages and poll reads by the applicable absolute deadline, stops pagination at the closing idle entry, and drops the admission deadline from wake scheduling once evidence resolves admission. Regressions exercise a hung polling page, a delayed window page, unnecessary pages after the boundary, and a recovered admission with a delayed terminal. |
| P2.2 | Addressed | `opencode.ts:208–226, 1814–1820` keeps the 404/HTML legacy signals and correct auth handling, while HTTP 503 and malformed JSON surface as health-check errors. Tests cover both formerly misclassified responses. |

### What's addressed

- **Amended headless acceptance (W11):** P1.1 was resolved by the registered plan amendment and is not a required prior finding in this review. In `opencode-live.test.ts:85–261, 445–620`, a single raw observer starts before prompting, and a matching positive-control form is required. The control and deny arm use the same model, server, prompt, and isolated working directory, with distinct sessions and prompt IDs. The deny arm requires provider `done` without an error, no matching question call or form, and continuous raw observation through the first deny-session terminal event after delivery. A missing form, gap, missing terminal event, or provider error cannot count as a pass. Control cancellation is fixture cleanup; there is no production cancel-and-continue policy.
- **Live acceptance evidence:** I checked both successful transcripts (`agent-004.ndjson` and the second-run live log). Each shows `opencode v2.4.2` (equal to `MIN_OPENCODE_VERSION`), five passing cases and no skips. Both show the observer connected before either prompt, a `question` form on the allow-only control, control interruption after fixture cancellation, and a deny arm with only `execute`, no form, provider `done`, and raw `session.execution.succeeded`. This verifies both provider modes and the amended comparison on the reviewed code. The independent rerun also observed the control form and complete raw coverage; the deny arm failed with the hosted model's explicit free-usage-limit error, so that run does **not** count as a pass. The failure confirms the test does not treat absence during an errored turn as acceptance.
- **Local deterministic verification:** `bun test test/unit/providers` passed (323 tests). The configured phase-finish quality run passed; its full unit suite logged 4,431 tests passing. No code or plan changes were made during this review.

### Nonblocking follow-ups

- The plan's title-block status still says the v1.9 amendment is pending review. That line is outside the governing contract and is stale relative to the registered amendment; use the durable revision, not that status line.
- The live observer checks the terminal predicate again after collecting provider events. The outer test timeout still bounds the case, but timestamping the raw terminal at receipt would make the test's narrower raw-event wait budget explicit even when collection finishes late. Similarly, retaining the order of a post-terminal stream end would avoid treating a later disconnect as an observation gap. Neither timing edge affects the two passing transcripts.
- **Future PR description:** record the verified output `opencode v2.4.2` when the PR is opened. No PR was created or pushed in this review.

### Updated readiness

**Ready.** All required prior items are addressed and the successful live transcripts satisfy the effective v1.9 headless comparison at the pinned minimum. No new blocking finding was found in the correction range.

## Addendum (November 27, 2026) — Phase 2 closure after governance merge

**Reviewed range / context:** `aa99077eca2d6d7471e806b8d3fb40bc135bc2f2..cf351476d70da58309f2a0d9428a12589082791c`, context `42f054f5-88ce-4fae-8966-e295ffcd123e`, iteration 2. The binding remains enforced and the effective plan remains registered v1.9 (`amendment:9284200c43a9379afe49ff0d13d65fc0ec48fb249895d2143fd368b110da089e`). This context requires no prior-finding outcomes or credit realizations.

### Verification

- Retrieved and inspected the exact governed diff. The merge changes 5x budget governance and its tests and instructions, not Phase 2 provider code, dependencies, provider tests, or the approved plan. No new Phase 2 blocker was introduced. `git diff --check` passed for the range.
- The governance change keeps inherited budget information as telemetry rather than an implementation gate. It preserves credit-shortfall and implementation-finding routes and leaves historical inherited-budget observations in the audit trail. This fresh review does not replay the prior closure outcomes.
- Prior live acceptance remains applicable to the unchanged provider and live test. Both successful runs recorded `opencode v2.4.2`, the pinned minimum, with five passes and no failures or skips. The observer connected before either prompt and remained live through the deny terminal; the allow-only control produced a `question` form, while the deny session had no matching `question` call or form and reached provider `done` and raw `session.execution.succeeded`. This is prior live evidence, not a rerun at the merge. Configured quality verification at the merged head runs separately and was not duplicated here.

### Nonblocking follow-ups

- The informational plan status still says the amendment is pending review. Use the registered revision above, not that stale status line.
- Record `opencode v2.4.2` in the PR description when the PR is opened.

### Updated readiness

**Ready.** The merge does not change Phase 2 implementation or live acceptance, and this closure found no new Phase 2 blockers. Record the verdict against this context and verify the independently run quality gates before marking the phase complete.
