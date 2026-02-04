# Staff Review Document Template

> **Purpose:** This template provides a standard structure for staff-level engineering reviews of commits, implementation phases, design documents, and plans. Reviews ensure production readiness, identify risks early, and create trackable artifacts for follow-up.
>
> **File naming:** `{YYYY-MM-DD}-{subject-slug}-review.md`
> - Commit reviews: `2026-01-12-commit-1c77074e-review.md`
> - Phase reviews: `2026-01-05-mcp-server-phase3-query-tools-review.md`
> - Plan/design reviews: `2025-12-24-mcp-server-implementation-plan-review.md`
>
> **When to use:** For any non-trivial implementation work, security-sensitive changes, or architectural decisions that benefit from independent staff-level scrutiny.

# Review: {Subject Title}

**Review type:** `{commit hash}` | `{plan doc path}` | `{design doc path}`  
**Scope:** {Brief scope description}  
**Reviewer:** Staff engineer ({focus areas: security, reliability, operability, etc.})  
**Local verification:** {Test command + result | Not run (static review)}

**Implementation plan:** `{docs/development/NNN-impl-feature.md}` | N/A  
**Technical design:** `{docs/api-reference/NNN-feature.md}` | N/A

## Summary

{2-4 sentences capturing: what this delivers, overall readiness assessment, and the 1-2 most critical gaps if any.}

**Readiness:** {Ready | Ready with corrections | Not ready} — {one-line rationale}

---

## What shipped

{Bulleted list of high-level deliverables. Skip for plan/design reviews.}

- **{Component/area}**: {brief description}
- **{Component/area}**: {brief description}

---

## Strengths

{3-5 bullets on what's working well and should be preserved.}

- {Strength with brief rationale}
- {Strength with brief rationale}

---

## Production readiness blockers

### P0.{n} — {Issue title}

**Risk:** {1-2 sentences on what breaks / security/correctness impact}

**Requirement:** {Clear acceptance criteria}

**Implementation guidance:** {Optional: suggested approach or code pointers}

---

## High priority (P1)

{Issues that should be addressed before broad rollout but don't block initial use.}

### P1.{n} — {Issue title}

{Brief description + recommendation}

---

## Medium priority (P2)

{Polish, hardening, or future-proofing items.}

- **{Item}**: {Brief description}
- **{Item}**: {Brief description}

---

## Readiness checklist

**P0 blockers**
- [ ] {Checklist item matching P0 above}
- [ ] {Checklist item}

**P1 recommended**
- [ ] {Checklist item matching P1 above}
- [ ] {Checklist item}

---

## Addendum ({date}) — {Brief title}

**Reviewed:** `{follow-on commit}` | {doc version}

### What's addressed (✅)
- **{P0/P1 item}**: {How it was resolved}

### Remaining concerns
- {Any items that are still open or newly identified}

### Updated readiness
- **{Phase/deliverable} completion:** ✅ | ⚠️ | ❌ — {rationale}
- **Ready for next phase:** ✅ | ⚠️ — {conditions if any}
