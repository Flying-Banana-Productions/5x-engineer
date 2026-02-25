export const DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE = `# {Feature/Change Title}

**Version:** 1.0
**Created:** {Month Day, Year}
**Status:** Draft

## Overview

{Describe current behavior, desired behavior, and why this change is needed.}

## Design Decisions

**{Decision statement}.** {Rationale and trade-offs.}

## Phase 1: {Title}

**Completion gate:** {How you know this phase is done.}

- [ ] {Checklist item}
- [ ] {Checklist item}

## Phase 2: {Title}

**Completion gate:** {How you know this phase is done.}

- [ ] {Checklist item}
- [ ] {Checklist item}

## Files Touched

| File | Change |
|------|--------|
| {path/to/file.ts} | {Brief description} |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | {file} | {Behavior} |
| Integration | {file} | {Workflow} |

## Not In Scope

- {Explicitly excluded item}

## Revision History

### v{N}.{M} ({date}) — {Short title}

- {What changed after review}
`;

export const DEFAULT_REVIEW_TEMPLATE = `# Review: {Subject Title}

**Review type:** {commit hash | plan path | design path}
**Scope:** {What was reviewed}
**Reviewer:** Staff engineer
**Local verification:** {Command + result | Not run}

## Summary

{Overall readiness and critical findings.}

**Readiness:** {Ready | Ready with corrections | Not ready} — {One-line reason}

## Strengths

- {Strength}
- {Strength}

## Production Readiness Blockers

### P0.{n} — {Issue title}

**Risk:** {Impact if not fixed}

**Requirement:** {Clear acceptance criteria}

## High Priority (P1)

### P1.{n} — {Issue title}

{Recommendation and rationale}

## Medium Priority (P2)

- {Improvement opportunity}

## Readiness Checklist

**P0 blockers**
- [ ] {Item}

**P1 recommended**
- [ ] {Item}

## Addendum ({date}) — {Title}

### What's Addressed

- {Resolved item}

### Remaining Concerns

- {Open item}
`;
