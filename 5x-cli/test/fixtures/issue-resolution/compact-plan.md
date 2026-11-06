<!-- 5x:plan-schema:1 -->

**Version:** 1.0
**Created:** November 5, 2026
**Status:** Draft

<!-- 5x:contract:start -->

# Resolve issue 42: project override precedence

## Overview

Project-level config overrides are ignored when a user-level value is also set. The project value must win. This is a localized fix in the config resolver, so the plan uses compact mode.

## Design Decisions

**Fix precedence in the existing resolver.** The merge order in `src/config/resolve.ts` applies user values last; reversing the order is the smallest correct change. No new abstraction is needed.

**Brief assumption carried forward.** The brief assumes environment variables keep their current highest precedence; this plan does not change them.

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Apply project overrides after user values, with a precedence regression test | 1 | 0 | - | - | One function in one file plus its test |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Issue Coverage

Source brief: docs/development/issues/218-issue-42-override-precedence/brief.md at 0123456789abcdef0123456789abcdef01234567

| Source | Criterion | Work / phase | Evidence required |
|---|---|---|---|
| github.com/OWNER/REPO#42 | AC1: project override wins over a user-level value | W1 / Phase 1 | Precedence regression test |
| github.com/OWNER/REPO#42 | AC2: environment variables still win over both | W1 / Phase 1 | Existing env precedence test still passes |

## Phase 1: Fix override precedence

**Completion gate:** The precedence regression test passes and `bun test test/unit/config` passes.

- [ ] Reverse the merge order in `src/config/resolve.ts`
- [ ] Add a regression test covering AC1 and confirm the AC2 test still passes

## Files Touched

| File | Change |
|------|--------|
| `src/config/resolve.ts` | Apply project overrides after user values (W1) |
| `test/unit/config/resolve.test.ts` | Precedence regression test |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/config/resolve.test.ts` | AC1 project override wins; AC2 env precedence unchanged |

## Not In Scope

- Changing environment-variable precedence.
- Reworking the config file format.

<!-- 5x:contract:end -->

## Revision History

### v1.0 (November 5, 2026) — Initial compact plan
