# 5x CLI v2 — Output Normalization

**Status:** Draft — Not Implemented
**Date:** July 13, 2026
**Part of:** v2 (`200-overview.md`, area #5)
**Breaking:** Yes — the one deliberate breaking pass in v2 (`200-overview.md` §4)

---

## 1. Problem (delta from v1)

The v1 output system (`docs/v1/100-architecture.md` §4a) is principled — global `--json`/`--text` selection, envelope-by-default, custom/generic/grandfathered formatter tiers — but the grandfathered tier and a few flag idioms leak inconsistency to every caller:

- **`init` and `upgrade` are text-only**, printing `console.log` prose directly (`src/commands/upgrade.handler.ts:358-403`), outside the format system entirely. `--json` is silently ignored. An agent or script driving setup cannot get a machine-readable result for exactly the commands that establish the machine-readable world.
- **`harness install` is split-brained**: `harness list`/`uninstall` go through `outputSuccess()` (`src/commands/harness.handler.ts:194,279`), but `install` prints raw `console.log` lines (`harness.handler.ts:399-423`). Same command group, two output regimes. This matters more in v2: `harness sync` (`201` §2.5) belongs to this family and needs a proper envelope from day one — it should not inherit the grandfathered style.
- **Double-default boolean flags**: `protocol validate` defines both `--require-commit` (default on) and `--no-require-commit`, likewise `--phase-checklist-validate`/`--no-phase-checklist-validate` (`src/commands/protocol.ts:63-77`). Help lists both directions of a flag whose default is already the positive — the reader can't tell what happens when neither is passed.
- **`run watch`** streams NDJSON outside the envelope system — correct for a stream, but undocumented as a contract; it reads as another grandfathered stray.

**Reclassified, not a defect:** `protocol emit` writing **raw canonical JSON** on success is deliberate and load-bearing — the agent includes emit's stdout *verbatim* as its structured result, and `protocol validate` auto-detects raw vs enveloped input (`src/commands/protocol-emit.handler.ts:1-10`). Wrapping it would break its purpose. The v1 gap is that this contract lives in a code comment instead of the architecture doc. v2 documents it; it does not "fix" it.

---

## 2. Design

### 2.1 Normalize `init`, `upgrade`, `harness install`

All three join the standard format system: `outputSuccess()` envelope in JSON mode, current prose (as custom text formatters) in `--text` mode.

- **Envelope shapes** — _TODO:_ define `data` for each. Sketches: `init` → `{ created: string[], db: { path, schemaVersion }, templates: {...} }`; `upgrade` → `{ config: {...}, db: { from, to }, templates: {...} }` mirroring its current section prose; `harness install` → the `InstallSummary` pair already returned by the plugin (`{ skills: { created, overwritten, skipped }, agents: {...}, rules?: {...} }` — the data exists, it's just printed instead of enveloped).
- **Human output preserved**: the existing prose becomes each command's custom text formatter — humans running `5x init` in a TTY with `FIVEX_OUTPUT_FORMAT=text` see what they see today. The *default* (JSON) is what changes.
- `harness sync` (`201`) and `doctor` (`203`) ship envelope-native from the start; this pass makes their family consistent rather than adding two more exceptions.
- _TODO:_ does interactive `init` (any prompts?) constrain JSON mode — should JSON mode imply non-interactive with defaults, matching `5x prompt --default` semantics?

### 2.2 Document the deliberate exceptions

Amend the v2 successor of §4a with an explicit **contract table**:

| Command | stdout contract | Why |
|---|---|---|
| `protocol emit` (success) | Raw canonical `AuthorStatus`/`ReviewerVerdict` JSON, no envelope | Output is pasted verbatim as an agent's structured result; `protocol validate` auto-detects both shapes |
| `protocol emit` (error) | Standard error envelope | Errors are for the caller, not for pasting |
| `run watch` | NDJSON event stream (or `--human-readable` text); pre-stream errors are standard envelopes | A stream has no single envelope |

Everything else: envelope in JSON mode, formatter in text mode — **zero undocumented exceptions** is the post-v2 invariant.

### 2.3 Flag idiom cleanup

- Drop the redundant positive flags where the default is already positive: keep `--no-require-commit` and `--no-phase-checklist-validate` only (Commander's native negation idiom); help states the default behavior in the description. Passing the removed positive flag errors with a pointer to the default.
- _TODO:_ sweep for other double-default pairs across commands (`--ready`/`--no-ready` on `emit` is *not* one — there is no default; it's a required three-state choice and stays).
- _TODO:_ `--dry-run` consistency (only `plan archive` has it today) — in scope for this pass or deferred? Leaning deferred: additive, not a normalization concern.

### 2.4 Error-contract touch-point

`203` §2.3 adds the remediation line to text-mode errors (additive, ships independently). This pass owns the *breaking* side if any is needed — _TODO:_ confirm text-mode error stream stays stderr-only and single-envelope-on-stdout stays the JSON-mode invariant; no known change required beyond documentation.

---

## 3. Migration (breaking)

The complete enumeration of breaking surface — this list is the v2 break, in full:

| Change | Who breaks | Migration |
|---|---|---|
| `init` default output: prose → JSON envelope | Scripts parsing `5x init` stdout text | Parse the envelope, or set `--text`/`FIVEX_OUTPUT_FORMAT=text` for old-style prose |
| `upgrade` default output: prose → JSON envelope | Same pattern | Same |
| `harness install` default output: prose → JSON envelope | Same pattern (incl. any tooling scraping "Created skill:" lines) | Same — the envelope carries the same created/overwritten/skipped data structurally |
| `--require-commit`, `--phase-checklist-validate` positive flags removed | Callers passing the explicit positive | Drop the flag — it was the default |

Notes:

- **Skills/agents are the main callers and are bundle-updated in lockstep** — the v2 skills re-render (`204` §2.4) lands with this pass, so the in-repo blast radius is one coordinated release. The migration table above is for *user* scripts.
- Grandfathered-prose consumers get a one-line escape hatch (`FIVEX_OUTPUT_FORMAT=text`) rather than a rewrite.
- Ship all of §2 in a single 2.0 release — the point of bundling the break (`200-overview.md` §4) is that "what changed about output in 2.0" has exactly one answer.

---

## 4. Open questions

- _TODO:_ envelope `data` shapes for `init`/`upgrade` (§2.1).
- _TODO:_ JSON mode ⇒ non-interactive for `init` (§2.1)?
- _TODO:_ full double-default flag sweep (§2.3).
- _TODO:_ `--dry-run` consistency — this pass or deferred (§2.3)?
