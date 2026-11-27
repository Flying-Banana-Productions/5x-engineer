# Review: OpenCode 2.x Phase 3 — Doctor and configuration

**Review type:** Implementation review of `52b266ad208e1f3c1da890aeeb783b995db19b4d`  
**Scope:** Phase 3 (§§3.1–3.2), W4; doctor portion of operator criterion AC2  
**Reviewer:** Staff engineer  
**Local verification:** `bun test test/unit/doctor test/unit/config-registry.test.ts test/integration/commands/doctor.test.ts` — 168 passed, 0 failed. An isolated PATH without OpenCode returned `kind: "missing"`. Two focused probes reproduced the findings below.

## Review Context

- Phase / review kind: 3, initial material pass, enforced
- Reviewed range: `cbb4b45314db14e9f3e98f5d624124c1f8d59e32..52b266ad208e1f3c1da890aeeb783b995db19b4d`
- Binding / review context: `d175e674-cbdd-4fff-90f3-93619ffe02fc` / `f05c6816-8f52-4c13-a2c6-43f6b014e965`
- No prior outcomes, due credit, operating restrictions, waivers, or effective inherited alerts to reconcile.

## Summary

**Readiness:** Ready with corrections — two mechanical fixes to a detect-only warning. The fake 1.x CLI integration case supplies the Phase 3 evidence for AC2; this review does not reapprove Phase 2 provider evidence.

## Strengths

- Role applicability uses the existing layered configuration resolver, including root defaults and nearest configuration where that resolver applies it. It also checks the configured home for a user harness manifest. The binary is not run when neither signal applies.
- The version probe uses argv without a shell, ignores stdin, and sets a five-second deadline. Missing and outdated results are non-fixable warnings, with the expected upgrade hints for supported version-output forms.
- The `opencode.url` change is description-only. Both environment names match the existing password lookup; no secret, new config field, or authentication behavior was added.

## Medium Priority (P2)

### P2.1 — Resolve project manifests from the current checkout

**Classification:** `implementation_defect`, `auto_fix`  
**Approved work items:** W4

**Risk:** A linked worktree with an installed OpenCode harness can miss the only warning that identifies a missing or outdated binary. The inverse can happen when only the main checkout has the manifest.

**Requirement:** Project manifest applicability must match the checkout where `5x harness install` and the adjacent freshness check look for project assets; provider applicability must still use layered configuration.

**Evidence / correction:** `src/doctor/checks/opencode.ts:127–134` hands `ctx.projectRoot` to the harness location resolver. `doctor.handler.ts` sets that property to the control-plane root, which can be the main checkout; `harnesses/freshness.ts:71–73` resolves the current checkout from `startDir` instead. In a temporary managed linked worktree, with both configured roles using `sample`, an empty user home, and a manifest only in the linked checkout, the injected missing-binary runner was called zero times and the check returned no finding. Use the existing checkout-root lookup for project manifest discovery, as freshness does, without changing the provider config root. Add a linked-worktree regression.

### P2.2 — Treat only successful OpenCode version output as version evidence

**Classification:** `implementation_defect`, `auto_fix`  
**Approved work items:** W4

**Risk:** A launcher diagnostic containing an unrelated version produces an incorrect `opencode-outdated` warning and can recommend a major upgrade for an unknown installed version.

**Requirement:** Emit an outdated finding only when the probe identifies an actual installed OpenCode version below the minimum.

**Evidence / correction:** `src/doctor/checks/opencode.ts:105–110,166–173` scans the first numeric token in combined stdout and stderr and ignores the exit status. A fake PATH launcher that printed `launcher needs Node 1.2.3` on stderr and exited 1 produced an `opencode-outdated` warning with `opencode upgrade --major`. Ignore nonzero exits and recognize complete OpenCode version lines (the supported bare and prefixed forms) rather than extracting version-like fragments from diagnostic text. Add regression cases for nonzero exit output and version-like noise.

## Nonblocking follow-ups

- Operator warning: the status banner above the plan contract still says the Phase 2 amendment is pending review. For execution, use the effective amendment and binding in this review context, not the stale banner or historical checklist claims.
- The prescribed `5x commit --files` stages dirty run journals as well as the named file. The review is committed by explicit path to honor the artifact-only requirement; existing run journal changes are left for the parent.

## Addendum (2026-11-27) — Phase 3 closure

**Reviewed range / context:** `52b266ad208e1f3c1da890aeeb783b995db19b4d..b7e4d1f2e9a03e897dc51631354d973ff27b65d9` / `1479804d-9426-4acc-be1b-801a7abe3ba0`

**Local verification:** `bun test test/unit/doctor test/unit/config-registry.test.ts test/integration/commands/doctor.test.ts` — 173 passed, 0 failed, including the fake 1.x CLI acceptance case.

### Prior-finding outcomes

| Finding ID | Outcome | Evidence |
|---|---|---|
| P2.1 | Addressed | `src/doctor/checks/opencode.ts:127–150` leaves provider resolution rooted at the control plane, while project manifest lookup uses the checkout resolved from `startDir`, matching harness installation and freshness. The real linked-worktree fixture in `test/unit/doctor/opencode.test.ts:282` verifies that a manifest local to the linked checkout triggers the probe there and not in the main checkout. |
| P2.2 | Addressed | `src/doctor/checks/opencode.ts:101–118,180–190` ignores nonzero exits and matches complete version lines. The new tests reject diagnostic fragments and even a bare version on nonzero exit; the passing integration test confirms the 1.x upgrade hint still works. |

### Remaining concerns

No new blocking issue in the correction range. The informational plan-status warning above still applies; the bound amendment governs.

### Updated readiness and credit realization

**Ready.** Both prior findings are addressed. No approved credit claim is due in this closure.
