/**
 * Shared schema 1 document for authority-reader tests.
 * Bookkeeping, an outside phase, and an outside budget sit before the contract.
 * A note inside phase 1 carries a phase, a checklist, and a budget table that
 * must not govern. The in-contract budget is the ledger.
 */

const CLAIM = "DC0 (`intrinsic`)";

export const SCHEMA1_STATUS = "Draft — 状态 line";
export const SCHEMA1_STALE_TEXT = "Bind execution to the approved plan.";
export const SCHEMA1_NOTE_ONLY_TEXT = "NOTE_ONLY_STALE_TEXT";
export const SCHEMA1_OVERVIEW = "Governing overview.";

export const SCHEMA1_AUTHORITY_PLAN = `<!-- 5x:plan-schema:1 -->
**Version:** 1.0
**Status:** ${SCHEMA1_STATUS}

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W9 | Outside | 1 | 0 | - | - | Ignore |

### Surface Snapshot

- Subsystems: 9
- Production files: 9
- Persistent/external boundaries: 0
- New shared abstractions or public contracts: 0

## Phase 9: Outside

**Completion gate:** Outside gate.

- [x] Outside item

<!-- 5x:contract:start -->
# Shared schema 1 plan

**Version:** 9.9
**Status:** Inside status must not win

## Overview

${SCHEMA1_OVERVIEW}

## Design Decisions

Keep the approved ledger.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | -1 | ${CLAIM} | - | Required |

### Debt Claims

#### DC0

- Target phase: phase-1
- Minimal-compliant effort delta: 0
- Minimal-compliant architecture delta: -1
- Before: two readers
- After: one projection

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0
- New shared abstractions or public contracts: 1

## Phase 1: Bind

**Completion gate:** Tests pass.

<!-- 5x:note:start id="context" -->
## Phase 8: Noted

## Delivery Budget

- Estimate confidence: low

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W8 | Noted | 1 | 0 | - | - | Ignore |

### Surface Snapshot

- Subsystems: 8
- Production files: 8
- Persistent/external boundaries: 0

**Completion gate:** Noted gate.

- [x] Noted item
${SCHEMA1_NOTE_ONLY_TEXT}
<!-- 5x:note:end id="context" -->

${SCHEMA1_STALE_TEXT}

- [x] First item
- [ ] Second item

## Phase 2: Finish

**Completion gate:** Done.

- [ ] Third item

## Acceptance

The projection is the contract.

## Not In Scope

Excluded work stays excluded.

<!-- 5x:contract:end -->

## Revision History

Bookkeeping stays outside.
`;

export function withSchema1Status(markdown: string, status: string): string {
	const from = `**Status:** ${SCHEMA1_STATUS}`;
	const index = markdown.indexOf(from);
	if (index < 0) throw new Error("schema 1 status line is missing");
	return (
		markdown.slice(0, index) +
		`**Status:** ${status}` +
		markdown.slice(index + from.length)
	);
}
