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
