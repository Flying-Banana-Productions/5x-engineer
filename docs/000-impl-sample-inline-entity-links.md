# Inline Entity Links

**Version:** 1.2
**Created:** January 23, 2026
**Status:** Complete — archived

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Single markdown parse with preprocessing** | Splitting into multiple independent renders breaks inline semantics (lists, paragraphs). Preprocessing `[[entity:...]]` into standard markdown links before a single render preserves document structure. |
| **Custom URL scheme (`entity://`)** | Enables component override for `<a>` tags without interfering with real URLs. Requires a URL transform to bypass markdown sanitization. |
| **Namespaced `data-*` attribute** | Existing detail-view selectors use `data-entity-id` for scroll-to-highlight and animations. Reusing it on message links would cause selector collisions. Use `data-message-entity-link-id` instead. |
| **Strip incomplete links during streaming** | Partial `[[entity:` tokens during streaming would leak raw UUIDs. Drop unterminated protocol suffixes from rendered text until the closing brackets arrive. |
| **Reuse existing navigation context** | Avoids hardcoded URLs and preserves view state + whitelisted params already handled by the navigation context. |
| **Explicit prompt exception for UUIDs** | System prompt forbids UUIDs in responses. Adding a scoped exception for the entity-link protocol maintains the general rule while enabling the feature. |

### References

- [Staff Review](development/reviews/2026-01-24-sample-inline-entity-links-review.md) — initial plan review + 4 addendums tracking implementation to production readiness

---

## Overview

The AI assistant references entities (records, users, resources) by name in message text. Users must manually locate these entities in the UI. This plan adds clickable inline links that navigate directly to the referenced entity with scroll-to-highlight.

**Current behavior:**
- Assistant mentions entities by name only ("Alice's 9 AM appointment with Dr. Chen")
- User must manually navigate to the correct view and find the entity

**New behavior:**
- Assistant embeds structured entity references: `[[entity:UUID:TYPE|Label]]`
- References render as inline links within the message markdown
- Clicking a link navigates to the entity's detail view and highlights it
- During streaming, incomplete link syntax is hidden (no UUID leakage)
- Plain-text rendering paths (exports, logs) strip the protocol entirely

---

## Design Decisions

**Preprocess into standard markdown links, then render once.** The alternative (splitting text into segments and rendering each independently) breaks markdown structure — a link inside a list item would produce `<li>prefix</li><a>link</a><li>suffix</li>`. Preprocessing `[[entity:...]]` into `[Label](entity://UUID?type=TYPE)` before a single markdown render preserves inline semantics. An escape helper handles markdown-sensitive characters (`]`, `\`) in labels.

**Use `<a>` with real navigable `href`, not `<button>`.** The user story is "clickable links." Link semantics preserve accessibility behaviors (open in new tab, copy link address). The component sets a concrete URL via a shared URL builder and intercepts clicks for SPA navigation.

**Enforce the "no UUIDs in responses" rule with a scoped exception.** Rather than removing the prompt rule (which prevents ID leakage in normal responses), add an explicit carve-out: UUIDs are allowed *only* inside the `[[entity:...]]` protocol. A `stripEntityLinks()` function exists for any plain-text rendering context.

**Fail safe during streaming.** The preprocessing step detects unterminated `[[entity:` sequences at the end of streaming text and strips them. This is O(n) via string search (no regex backtracking risk). The worst case is a brief delay before the link appears — never a leaked UUID.

---

## Phase 0: Shared Parsing Utilities - COMPLETE

**Completion gate:** All parsing functions exported with full unit test coverage; no UI changes.

### 0.1 Protocol definition and parsing

Define the entity link protocol and shared utilities:

- `parseEntityLinks(text)` — extract all `[[entity:...]]` references with positions
- `preprocessEntityLinks(text)` — rewrite protocol into standard markdown links (`[Label](entity://...)`)
- `stripEntityLinks(text)` — remove all entity link syntax for plain-text contexts
- `stripIncompleteEntityLink(text)` — drop unterminated protocol suffix (for streaming)
- `escapeMarkdownLinkText(label)` — escape `]`, `\` in labels before markdown preprocessing
- `parseEntityUrl(url)` — extract entity ID and type from `entity://` URLs

All functions normalize entity type to lowercase for case-insensitive robustness.

### 0.2 Validation

UUID validation uses the shared `isValidUUID()` utility. Invalid IDs are silently stripped (no render, no error).

- [x] Protocol parsing with edge cases (nested brackets, empty labels, missing type)
- [x] Preprocessing into valid markdown links
- [x] Stripping for plain-text contexts
- [x] Incomplete link detection and stripping
- [x] Markdown-sensitive character escaping
- [x] UUID validation via shared utility
- [x] Case-insensitive type normalization
- [x] Unit tests for all functions

---

## Phase 1: System Prompt Update - COMPLETE

**Completion gate:** Prompt allows entity-link protocol; strip function covers plain-text paths.

- [x] Add scoped UUID exception to assistant system prompt: "UUIDs allowed only in `[[entity:...]]` and must never be displayed verbatim to users"
- [x] Integrate `stripEntityLinks()` in any plain-text rendering paths (exports, logging)
- [x] Verify existing "no UUIDs" tests still pass with the exception

---

## Phase 2: Entity Link Component - COMPLETE

**Completion gate:** Component renders inline links with navigation, keyboard handling, and accessibility; no DOM selector collisions.

### 2.1 Link component

- Renders as `<a>` with ARIA label and keyboard handling (Enter + Space)
- Uses `data-message-entity-link-id` (NOT `data-entity-id` — prevents selector collision with detail-view scroll-to-highlight)
- Calls existing navigation context on click (`navigateToEntity({ id, type, scrollToHighlight: true })`)
- Falls back gracefully if navigation context is unavailable (link renders but click is no-op)
- Sets a real navigable `href` via shared URL builder for "open in new tab" / "copy link address"

### 2.2 URL builder integration

- Navigation context exposes `getEntityUrl({ id, type })` using the same param whitelist as SPA navigation
- Entity link component uses `getEntityUrl()` for its `href`
- SPA navigation delegates URL construction to the same builder (eliminates duplication)

- [x] Component renders as `<a>` with keyboard handling and ARIA label
- [x] Namespaced `data-*` attribute (no selector collisions)
- [x] Navigation via existing context (preserves view state + whitelisted params)
- [x] Real navigable `href` via shared URL builder
- [x] Graceful fallback when navigation context unavailable
- [x] Component tests (click, keyboard, DOM attributes, navigation context calls)
- [x] Test proving `data-entity-id` is NOT present on the component

---

## Phase 3: Markdown Integration - COMPLETE

**Completion gate:** Entity links render inline in message markdown with streaming safety; no UUID leakage during streaming.

### 3.1 Markdown preprocessing

- Message text component calls `preprocessEntityLinks()` before the single markdown render
- URL transform configured to preserve `entity://` scheme (markdown sanitizer strips unknown schemes by default)
- Component override for `<a>` detects `entity://` URLs and renders the entity link component

### 3.2 Streaming safety

- When `isStreaming=true`, apply `stripIncompleteEntityLink()` before rendering
- O(n) string search implementation (no regex backtracking)

- [x] Single markdown render with preprocessing (no segment-level independent renders)
- [x] URL transform preserves `entity://` scheme
- [x] Component override renders entity links for `entity://` URLs
- [x] Streaming strips incomplete `[[entity:` sequences
- [x] Component tests for inline rendering (inside paragraphs, lists, mixed with other markdown)
- [x] Component test proving UUIDs never appear during streaming
- [x] Component test proving `href` is preserved through URL transform

---

## Phase 4: Documentation & Cleanup - COMPLETE

- [x] Update plan status and phase checklists
- [x] Verify all tests pass (shared utilities, components, type check)
- [x] Document entity link protocol in relevant design docs

---

## Files Touched

| File | Change |
|------|--------|
| `packages/shared/src/entity-link.ts` | NEW — shared parsing, preprocessing, stripping, escaping utilities |
| `packages/shared/src/test/entity-link.test.ts` | NEW — unit tests for all shared utilities |
| `apps/web/app/components/messages/entity-link.ts` | NEW — entity link component with navigation |
| `apps/web/app/components/messages/message-text.ts` | MODIFY — integrate preprocessing + URL transform + streaming safety |
| `apps/web/app/contexts/navigation-context.ts` | MODIFY — add `getEntityUrl()` to shared URL builder; delegate SPA navigation to it |
| `src/ai/agent/system-prompt/assistant.ts` | MODIFY — add scoped UUID exception for entity-link protocol |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `entity-link.test.ts` | Protocol parsing, preprocessing, stripping, escaping, validation, type normalization |
| Component | `entity-link.test.tsx` | Rendering, click/keyboard navigation, DOM attributes, graceful fallback |
| Component | `message-text.test.tsx` | Inline rendering in markdown, streaming safety, URL transform, entity scheme preserved |

---

## Not In Scope

- **Multi-entity-type rendering** — MVP supports a single visual style; type-specific styling (different colors/icons per entity type) deferred
- **Bidirectional navigation** — links go from message to detail view only; "where was this entity mentioned?" is a separate feature
- **Real-time availability** — links navigate to the entity as it existed; if it was deleted or moved, the detail view handles the error

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 0 | Shared parsing utilities | 1 day |
| 1 | System prompt update | 0.5 day |
| 2 | Entity link component | 1.5 days |
| 3 | Markdown integration + streaming safety | 1.5 days |
| 4 | Documentation & cleanup | 0.5 day |
| **Total** | | **5 days** |

---

## Revision History

### v1.1 (2026-01-24) — Address plan review P0 blockers

Addresses items from [2026-01-24-sample-inline-entity-links-review.md](development/reviews/2026-01-24-sample-inline-entity-links-review.md):

**P0 blockers resolved:**
- **P0.1 — DOM selector collision**: Plan now explicitly forbids `data-entity-id` on message links; uses namespaced `data-message-entity-link-id` instead
- **P0.2 — Markdown structure**: Replaced segment-level independent renders with single markdown render + preprocessing approach
- **P0.3 — Streaming safety**: Added `stripIncompleteEntityLink()` with O(n) string search and explicit test requirement
- **P0.4 — Navigation correctness**: Replaced hardcoded URL construction with existing navigation context
- **P0.5 — Prompt consistency**: Added scoped UUID exception and `stripEntityLinks()` for plain-text paths

**P2 items resolved:**
- **Entity-type styling**: Added optional `TYPE` field to protocol for future use
- **Protocol coexistence**: Documented processing order with existing inline protocols

### v1.2 (2026-01-24) — Address P0.6 from re-review

**P0 blockers resolved:**
- **P0.6 — URL scheme stripping**: Added URL transform to preserve `entity://` scheme through markdown sanitization; added test proving `href` reaches component

**P1 items resolved:**
- **Label escaping**: Added `escapeMarkdownLinkText()` helper with tests for `]` and `\` characters
