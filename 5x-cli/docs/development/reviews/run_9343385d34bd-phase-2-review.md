# Review: Git-native run records — Phase 2

**Review type:** `5e9ac3df40dbe80f95f4675f131b6fa2a75091df` (and follow-ons through `HEAD`)  
**Scope:** Phase 2 config keys, git attributes, and installation identity.  
**Reviewer:** Staff engineer (correctness, security, reliability, operability, tests)  
**Local verification:** `bun run typecheck && bun test --concurrent` — passed (3,029 tests); targeted Phase 2 suite — passed (151 tests).

**Implementation plan:** `docs/development/plans/212-git-native-run-records-plan.md`  
**Technical design:** `docs/v2/207-state-segmentation.md`

## Summary

The implementation adds the configured records root, fail-closed outside-repository validation, idempotent `.gitattributes` management, and a privacy-conscious user-scope identity format. It satisfies the Phase 2 functional completion gate and has focused test coverage. One correctness issue remains: concurrent first-use processes can each return a different installation ID because the create path uses replacement rename rather than exclusive publication.

**Readiness:** Ready with corrections — the remaining P1 is deterministic and `auto_fix`; no human product decision is needed.

---

## What shipped

- **Configuration:** Added `paths.records`, `records.redact`, and `records.actor`, registry discovery, path resolution, and inside-repository enforcement.
- **Repository attributes:** `init` and `upgrade` now maintain a scoped `merge=union` rule for record JSONL files.
- **Identity:** Added an external, mode-restricted UUID-v4 installation identity and explicit recorder actor precedence.

---

## Strengths

- Records roots outside the repository fail closed rather than silently disabling git-native history.
- Attribute writes preserve unrelated rules and are idempotent.
- The identity implementation avoids prohibited host, OS-user, and Git identity attribution sources.
- The implementation has both focused unit/integration coverage and a passing full concurrent suite.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — First-use identity creation is not concurrency-safe

**Classification:** `auto_fix`

`loadOrCreateInstallationIdentity` checks for existence and then publishes via `renameSync`. Two simultaneous first CLI invocations can both observe a missing file, generate different UUIDs, and each return its own UUID; the later rename overwrites the persisted file. The losing process can then emit records attributed to an installation ID that was never persisted, violating the stable per-installation identity guarantee and fragmenting provenance.

**Requirement:** Concurrent first loads must converge on the single persisted installation ID; no caller may return an ID that did not win publication.

**Implementation guidance:** Publish with an exclusive primitive (for example, atomically link a fully fsynced temporary file to the final path) and, on an already-exists race, discard the temporary file and reload/validate the winner. Add a concurrent first-load test that asserts all callers return the same ID and that it equals the stored value.

**Location:** `src/records/identity.ts:136-169`

---

## Medium priority (P2)

None.

---

## Readiness checklist

**P0 blockers**
- [x] No P0 blockers identified.

**P1 recommended**
- [ ] P1.1: Make first-use identity publication race-safe and cover concurrent creation.
