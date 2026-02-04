# Review: Inline Entity Links Implementation Plan

**Review type:** Implementation plan review
**Scope:** Entity deep-links rendered inline in message text; navigation to detail view with scroll-to-highlight; shared parsing utilities; prompt guidance
**Reviewer:** Staff engineer (UX correctness, reliability, security/data handling)
**Local verification:** Not run (static review: plan + code inspection)

**Implementation plan:** `docs/development/NNN-impl-inline-entity-links.md`
**Technical design:** N/A

## Summary

This feature is valuable and fits existing primitives already in the repo: scoped message context, detail-view navigation actions, and scroll-to-highlight behavior.

The current plan has several correctness issues that will either break navigation/highlighting or leak raw entity IDs during streaming. The markdown integration approach (splitting into multiple independent renders) also breaks inline semantics and will produce awkward DOM structure.

**Readiness:** Not ready -- address P0 blockers (DOM targeting, markdown strategy, streaming safety, prompt/policy consistency) before implementation.

---

## Strengths

- **Clear user value + UX intent:** clickable entity references are a real speedup vs. manually hunting in the UI.
- **Leverages existing affordances:** scroll-to-highlight already exists and is the right primitive to build on.
- **Good scoping:** single-entity-type deep links are a reasonable MVP constraint.

---

## Production readiness blockers

### P0.1 -- Entity links must not collide with existing DOM selectors

**Risk:** Multiple codepaths target entity DOM nodes via `data-entity-id` attribute selectors (scroll-to-highlight, move animations, etc.). If inline message links use the same attribute, these selectors can match the message element instead of the detail view card.

**Requirement:**
- Inline entity link elements MUST NOT use the same `data-*` attribute as the detail view.
- If any data attribute is needed, use a distinct namespace.

**Implementation guidance:**
- Remove the conflicting attribute from the proposed link component.
- Keep using `data-testid` for testing.

---

### P0.2 -- Replace the markdown integration approach; preserve inline semantics in a single parse

**Risk:** The plan's approach renders multiple independent markdown blocks per text segment. This breaks markdown structure (lists/paragraphs), produces invalid/awkward DOM flow, and can regress styling.

**Requirement:**
- Entity links render inline within the same markdown tree (inside paragraphs/lists) with no extra block breaks.
- Only one markdown parse/render per text part.

**Implementation guidance (pick one):**
- **Preferred:** Transform `[[entity:...]]` into an AST link node with a custom scheme via a parser plugin; render via component override for `<a>`.
- **Acceptable MVP:** Pre-process the markdown string into standard markdown links with correct escaping, then handle `<a>` rendering.

---

### P0.3 -- Streaming must never reveal raw entity IDs in UI

**Risk:** During streaming, incomplete tokens will show raw syntax (and thus entity UUIDs) until closing brackets arrive. The current plan's fallback explicitly renders raw text, which is the opposite of the goal.

**Requirement:**
- While streaming, the UI must not render partial entity link syntax containing IDs.
- Worst-case behavior should be to hide the incomplete tail token until it becomes complete.

**Implementation guidance:**
- When streaming and the text ends with an unterminated `[[entity:` sequence, drop that suffix from the rendered text.
- Add a targeted test proving IDs never appear during streaming.

---

### P0.4 -- Reuse existing navigation actions; don't hardcode URLs

**Risk:** The plan proposes a new navigation hook that hardcodes URL paths and rebuilds query params from scratch. This bypasses existing, reviewed logic that preserves view state and whitelisted params.

**Requirement:**
- Entity link clicks must use the existing navigation action.

**Implementation guidance:**
- In the link component, call the existing navigation context and fall back gracefully if not available.

---

### P0.5 -- Prompt/policy consistency: "no UUIDs" conflicts with embedding IDs in text

**Risk:** The system prompt instructs "do not include record IDs in responses." The plan requires embedding UUIDs in the response text, which conflicts with the prompt and can reduce compliance.

**Requirement:**
- Update prompt guidance to allow UUIDs *only* inside the entity-link protocol.
- Ensure any "plain text" rendering paths strip the protocol.

**Implementation guidance:**
- Add an explicit exception: "UUIDs allowed only in `[[entity:...]]` and must never be displayed verbatim to users."

---

## High priority (P1)

### P1.1 -- Use link semantics (`<a>`/`Link`) rather than `<button>`

The user story is "clickable links." Prefer `<a>` with an `onClick` handler to preserve expected accessibility semantics and behaviors (open in new tab, copy link address, etc.).

### P1.2 -- Align ID validation with existing shared utilities

The plan's regex/test examples are inconsistent (tests use non-UUID IDs while regex requires UUIDs). Use existing shared validation utilities and update tests to use real UUIDs.

---

## Medium priority (P2)

- **Entity-type styling:** Detail cards already use distinct type styling; if you want matching in messages, include `entityType` in the protocol (or defer).
- **Multiple protocols in one text:** Define processing order with any existing inline protocols to ensure they don't conflict.
- **State preservation expectations:** Confirm whether entity links should preserve current view filters or always force a specific view; document as product behavior.

---

## Readiness checklist

**P0 blockers**
- [ ] Entity link elements do not collide with existing DOM selectors
- [ ] Entity links render inline via a single markdown parse (no segment-level independent renders)
- [ ] Streaming never displays partial `[[entity:...]]` syntax/UUIDs
- [ ] Navigation uses existing context actions (no hardcoded URL construction)
- [ ] System prompt updated to allow entity-link protocol despite "no UUIDs" guidance

**P1 recommended**
- [ ] Use `<a>`/`Link` semantics for entity links
- [ ] Tests updated to use real UUIDs; validation centralized via shared utilities

---

## Addendum 1 -- Re-review after plan revisions

**Reviewed:** `docs/development/NNN-impl-inline-entity-links.md` (revised)

### What's addressed

- **P0.1 selector collision:** Plan explicitly forbids reusing the detail-view attribute and uses a namespaced alternative.
- **P0.2 markdown structure:** Plan moves to single markdown render, with preprocessing into standard links + component override for `<a>`.
- **P0.3 streaming safety:** Plan adds incomplete-link detection + stripping + explicit test requirement to avoid ID leakage.
- **P0.4 navigation correctness:** Plan reuses existing navigation context (preserves view + whitelisted params) and removes hardcoded URL construction.
- **P0.5 prompt consistency:** Plan calls out explicit UUID exception for the entity-link protocol and includes a strip function for plain-text contexts.
- **P2 type styling + protocol coexistence:** Plan adds optional type field and documents protocol processing order.

### Remaining concerns

### P0.6 -- Markdown renderer strips unknown URL schemes

The markdown renderer sanitizes link URLs; `entity://...` is transformed to `href=""`, so the component override will never see the scheme and links won't work.

**Requirement:**
- Provide a URL transform that allows the `entity://` scheme to pass through unmodified.
- Add a unit/component test proving `href` is preserved.

### P1 -- Escaping/encoding for markdown link text

The preprocessing approach must escape markdown-sensitive characters in the link label (at minimum `]` and `\`). Consider either a parser plugin (most robust) or an escape helper with tests.

### Updated readiness
- **Plan correctness:** Solid revision, but P0.6 must be fixed or links will be non-functional.
- **Ready to implement:** No -- address P0.6 first.

---

## Addendum 2 -- Review of implementation (5 commits)

**Reviewed:** Implementation plan + commits spanning Phases 0-4

**Local verification:**
- Shared utility tests: PASS
- Component tests: PASS
- Type check: PASS

### What's addressed

- **P0.1 selector collision:** Component uses namespaced attribute; explicitly does **not** set the detail-view attribute (with component test coverage).
- **P0.2 markdown structure:** Single markdown render; preprocessing rewrites protocol into standard links; component override renders inline entity links (list/inline semantics covered by tests).
- **P0.3 streaming safety:** Incomplete-link stripping is O(n) via string search (avoids regex backtracking) and is applied when streaming; both shared-unit and component tests assert IDs never appear during streaming.
- **P0.4 navigation correctness:** Click/keyboard activation calls existing navigation context (tests assert inputs).
- **P0.5 prompt consistency:** System prompt now allows UUIDs **only** inside the entity-link protocol; strip function exists for plain-text contexts.
- **P0.6 URL scheme stripping:** Component includes URL transform that preserves the entity scheme; test asserts the ID reaches the link component.
- **P1.1 link semantics:** Component renders as `<a>` with keyboard handling and ARIA label.
- **P1.2 validation/test consistency:** Shared utilities use centralized UUID validation; tests use real UUIDs consistently.
- **P1.3 label escaping:** Escape helper handles markdown-sensitive characters; unit + component tests cover edge cases.

### Remaining concerns
- **URL semantics vs "real links" (minor UX/a11y):** Component renders `href="#"` and intercepts clicks, so "copy link address" / "open in new tab" won't carry deep-link state. Acceptable for an internal app, but consider using a real navigable `href` for full link affordances.
- **Protocol robustness (minor):** Regex is case-insensitive; if a future producer emits different casing, it will match but be treated as default type downstream. Normalizing to lowercase in parsing would harden this.

### Updated readiness
- **Implementation completion:** Complete -- Phases 0-4 are implemented and test-covered; previously-blocking P0.6 is resolved.
- **Production readiness:** Ready / minor -- consider the hardening items above if heading for broad rollout.

---

## Addendum 3 -- Follow-up review (fix commit)

**Reviewed:** Commit addressing review concerns from Addendum 2

**Local verification:**
- Shared utility tests: PASS
- Component tests: PASS
- Type check: PASS

### What's addressed
- **Real navigable `href`:** Component now sets a concrete URL so browser features ("copy link address", "open in new tab") work as expected, while still using SPA navigation for clicks.
- **Protocol robustness:** Shared parsing now normalizes type to lowercase, with new unit tests.
- **Test harness correctness:** Component tests now provide proper router context where needed.

### Remaining concerns
- **State preservation for copied URLs (minor UX):** Generated `href` always targets a specific view and only includes minimal params. If "open in new tab" should preserve current filters, consider generating the URL from existing navigation logic.

### Updated readiness
- **Implementation completion:** Complete
- **Production readiness:** Ready -- no remaining P0/P1 issues from the original review; remaining items are optional UX polish.

---

## Addendum 4 -- Follow-up review (polish commit)

**Reviewed:** Commit implementing remaining UX suggestion from Addendum 3

**Local verification:**
- Component tests: PASS
- Type check: PASS

### What's addressed
- **Preserve view + filters in copied URLs:** Adds a URL builder to the navigation context using the same param whitelist and view detection as SPA navigation. Component now uses this for its `href`, so "open in new tab" preserves current view state and filters.
- **Architecture consistency:** SPA navigation now delegates URL construction to the shared builder, eliminating duplicated URL-building logic and reducing drift risk between "click navigation" and "href navigation."
- **Test updates:** Component tests mock the URL builder where needed, keeping tests deterministic.

### Remaining concerns
- **Minor error specificity:** Navigation now reports a generic "invalid input" for any invalid date. Acceptable, but consider restoring more specific messages for operator debugging.

### Updated readiness
- **Production readiness:** Ready -- this resolves the last open feedback item; remaining issues are cosmetic.
