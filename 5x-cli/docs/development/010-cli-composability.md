# Feature: CLI Composability — Unix Pipe Support

**Version:** 1.3
**Created:** March 6, 2026
**Status:** In Progress
**Review:** `docs/development/reviews/2026-03-06-010-cli-composability-plan-review.md`

## Overview

Current behavior: CLI commands produce JSON envelopes to stdout but cannot be easily composed. Piping `5x invoke author` output into `5x run record` requires 6+ `jq` extractions to decompose the envelope and reconstruct individual `--flag` arguments. The example `author-review-loop.sh` script dedicates ~40% of its lines to this plumbing.

Desired behavior: Commands compose naturally via Unix pipes. `5x invoke author author-next-phase | 5x run record` just works — no `jq`, no explicit `--result`, no `--session-id`, no `--tokens-in`, no step name. Run context (`run_id`, `phase`, `step_name`) flows through the pipe chain automatically. Template variables are auto-populated from upstream envelope data fields.

Why this change: The 5x CLI is designed as a set of composable primitives. The JSON envelope contract (`{ ok, data }`) is half the story — the other half is making commands capable of *consuming* upstream envelopes, not just producing them. Without this, every integration script requires verbose jq plumbing that obscures the actual workflow logic.

## Design Decisions

**Stdin has a clear priority order.** When stdin is piped, commands follow a deterministic priority for what consumes it: (1) `--result -` (explicit raw stdin read, existing behavior), (2) `--var key=@-` (stdin as a template variable value), (3) automatic upstream envelope parsing for context extraction. At most one consumer per invocation. This avoids ambiguity about what reads stdin.

**Context is embedded in `data`, not a separate `_meta` field.** Adding `run_id`, `step_name`, `phase`, and `model` directly to each command's `data` payload (rather than a wrapper `_meta` object) keeps the envelope shape flat and self-describing. These fields document what the command did — they also happen to be useful for downstream pipe consumers. No new abstraction layer.

**Step names are defined in template frontmatter.** Each prompt template declares a `step_name` field in its YAML frontmatter (required). This is the semantic workflow step name used for recording (e.g., `author:implement`, `reviewer:review`). The template author sets the step name once using the established `{role}:{action}` convention; callers never need to provide it manually. Step names flow through the pipe chain automatically: invoke outputs `data.step_name` from the template metadata, and `run record` extracts it from the piped envelope. The `run record` positional arg and `--record-step` flag remain available as overrides for edge cases. Since templates are copied to `.5x/templates/prompts/` by `5x init`, users can customize step names per-project by editing the frontmatter in their local copies. The standard mapping is:

| Template | `step_name` |
|---|---|
| `author-generate-plan` | `author:generate-plan` |
| `author-next-phase` | `author:implement` |
| `author-process-plan-review` | `author:fix-review` |
| `author-process-impl-review` | `author:fix-review` |
| `reviewer-plan` | `reviewer:review` |
| `reviewer-commit` | `reviewer:review` |

Note: multiple templates may share the same step name (e.g., both reviewer templates use `reviewer:review`). This is correct — they represent the same semantic workflow step in different contexts. The DB UNIQUE constraint `(run_id, step_name, phase, iteration)` differentiates them by phase.

**Upstream `data.*` string fields become implicit template variables.** When `5x invoke` reads a piped envelope, eligible `data.*` string values become available as template variable fallbacks, lower priority than explicit `--var` flags. This means `5x run init --plan plan.md | 5x invoke author author-next-phase` automatically fills `{{plan_path}}` from `data.plan_path` without needing `--var plan_path=plan.md`. Values that fail template safety validation (contain newlines or `-->`) are silently skipped — they're not suitable for template interpolation anyway. An explicit exclusion list prevents internal metadata fields from leaking into template scope: `run_id`, `session_id`, `log_path`, `cost_usd`, `duration_ms`, `model`, `step_name`, `ok`. Only fields that could plausibly be user-facing template variables are injected.

**Non-string data fields are excluded from template var injection.** Objects, arrays, numbers, and booleans from the upstream envelope are not injected as template variables. Template variables are always strings (the template engine enforces this). Only `typeof value === "string"` fields are candidates. Additionally, template rendering already rejects undeclared variables — only variables listed in the template's frontmatter `variables` array are substituted, so injected fields that don't match a declared variable are silently ignored.

**TTY auto-detect for pretty/compact JSON.** The current `--no-pretty` flag requires scripts to explicitly opt into compact output. The Unix convention is auto-detection: pretty when stdout is a TTY, compact when piped. This eliminates `--no-pretty` from every script while keeping interactive output readable. `--no-pretty` forces compact (existing), `--pretty` forces pretty (new) for edge cases.

**`run record` infers all fields from invoke envelopes.** When `run record` receives a piped invoke envelope, it recognizes the shape (has `result`, `session_id`, `tokens`, etc.) and auto-populates: `data.result` -> `--result`, `data.run_id` -> `--run`, `data.step_name` -> positional step name, `data.phase` -> `--phase`, plus all metadata fields (`session_id`, `model`, `duration_ms`, `tokens.in/out`, `cost_usd`, `log_path`). The step name comes from the template's `step_name` field via the invoke output. For non-invoke envelopes (e.g., quality output), `JSON.stringify(data)` becomes the result JSON and the step name positional is still required. CLI flags always override piped values.

**Stdin is parsed whenever it's piped and not consumed by `--result -`.** The pipe ingestion condition is: stdin is piped AND `--result -` was not specified. This is NOT gated on whether any particular field is present — the envelope is always parsed when stdin is available. Each field is then merged individually using `??=` (CLI flags take precedence). This ensures all partial-override scenarios work: `5x quality run | 5x run record "quality:check" --run R1` reads `result` from the pipe while `run` and step name come from CLI flags. `--result @./file.json | 5x run record` reads result from the file while `run_id` and `step_name` come from the pipe. Only `--result -` (raw stdin read) prevents envelope parsing since it consumes the stdin stream. Validation happens after merge, not before.

**Recording persistence is separated from CLI output.** The `runV1Record()` handler function currently performs both DB persistence and CLI output (`outputSuccess()`/`outputError()`). For `--record` on invoke/quality, a pure `recordStepInternal()` helper is extracted that performs DB validation and `recordStep()` without writing to stdout or throwing `CliError`. `runV1Record()` becomes a thin CLI wrapper around this helper. `invoke --record` and `quality --record` call the helper directly, ensuring only one JSON envelope is written to stdout (the primary command's output). Recording failures emit a warning to stderr and set a non-zero exit code, but never suppress or corrupt the primary envelope.

**`--record` uses the template's step name by default.** The `--record` flag is a boolean that enables auto-recording after invocation. The step name defaults to the template's `step_name` frontmatter field — no additional flag is needed for the common case. An optional `--record-step` flag allows overriding the template default for edge cases. For `quality run`, which has no template, `--record-step` defaults to `"quality:check"` (the only established quality step name).

**`5x init` and `5x upgrade` stay human-readable.** These are interactive, run-once maintenance commands — not pipeline primitives. There is no meaningful downstream consumer for their output. Forcing a JSON envelope would hurt the primary (human) use case for no composability gain. Only `5x skills install` needs fixing: it currently mixes `console.log` lines with a JSON envelope on the same stdout stream, breaking parsers.

**`5x skills install` stdout/stderr separation.** Skills install already outputs a JSON envelope via `outputSuccess()`, but also writes human-readable progress lines to stdout before the envelope. Moving those progress lines to stderr makes the stdout stream a clean, parseable envelope.

**`--var key=@path` and `--var key=@-` mirror the `--result` convention.** The `--result` flag already supports `@path` (read from file) and `-` (read from stdin). Extending this convention to `--var` is consistent and eliminates the need for command substitution to pass large values (e.g., diffs) as template variables. Only one `--var` can use `@-` per invocation.

**Pipe context extraction is a shared utility with dedicated stdin detection.** The logic for reading an upstream envelope from stdin, parsing it, and extracting context fields is shared between `run record` and `invoke`. A dedicated `src/pipe.ts` module centralizes this, keeping handlers clean and the parsing logic testable in isolation. Critically, `isStdinPiped()` in `src/pipe.ts` uses `process.stdin.isTTY` directly — it must NOT reuse anything from `src/utils/stdin.ts`, which has `/dev/tty` fallback logic designed for interactive prompts. Envelope ingestion and prompt reading are fundamentally different operations.

**Phase may be null for auto-recorded steps.** The DB schema's UNIQUE constraint `(run_id, step_name, phase, iteration)` treats null phase as distinct from any string phase value. When invoke is called without `--var phase_number=X`, or when quality runs outside a phase context, the recorded step has `phase: null`. This is valid and means "not phase-specific." Callers that know their phase should always provide `--phase` (or `--var phase_number=X` for invoke). When piped from invoke, `phase` is populated from `data.phase` (derived from the invoke handler's `variables.phase_number`). Phase-less recording does not break resumability or duplicate detection — it simply creates a separate uniqueness partition.

**Invoke output includes `model`.** `RunResult` from the provider layer does not expose `model`, but the invoke handler resolves it from config and CLI overrides. The resolved model string is included in the enriched `InvokeResult` output so it flows through the pipe to `run record`. This ensures the DB `model` column is populated for auto-recorded steps, matching the contract in `docs/v1/101-cli-primitives.md`.

**Design docs are updated before pipe consumers are built.** The current `docs/v1/101-cli-primitives.md` has stale invoke output shapes: it shows `status`/`verdict` wrapper keys and flat `tokens_in`/`tokens_out` instead of the actual `result` key and nested `tokens: { in, out }` structure. These docs are updated in Phase 2 before adding new pipe-enriched fields, so the documented contract matches the real code at every step.

**Template `step_name` has a graceful fallback for pre-existing scaffolded copies.** Since `5x init` and `5x upgrade` skip existing prompt files in `.5x/templates/prompts/` unless `--force` is used, locally scaffolded templates from before this change won't have `step_name` in their frontmatter. Rather than hard-failing, `parseTemplate()` falls back to a canonical mapping for known bundled template names and emits a warning to stderr directing users to run `5x init --force`. For unknown template names (user-created custom templates), `stepName` is `null` — these templates are not assumed to be workflow-aware. The `--record` flag validates that a step name is available (from template or `--record-step`) before attempting to record.

**Backward compatibility is preserved.** All changes are additive: new optional fields in output envelopes, new optional flags, relaxed `required` constraints on existing flags. Existing scripts that pass explicit flags continue to work unchanged. The only behavioral change is TTY auto-detect for pretty-printing, which produces identical JSON content — only whitespace differs.

## Phase 1: TTY Auto-Detect and Skills Install Fix ✓

**Status:** Complete (commit `cd69a31`)

**Completion gate:** Pretty-print defaults to TTY detection. `--pretty` flag added. `skills install` outputs a clean JSON envelope to stdout (progress messages moved to stderr). `init` and `upgrade` remain human-readable (no changes). All tests pass.

### 1.1 TTY auto-detect in `src/output.ts`

- [x] Change `prettyPrint` default from `true` to `process.stdout?.isTTY ?? false`

### 1.2 `--pretty` flag in `src/bin.ts`

- [x] Parse `--pretty` from `process.argv` alongside `--no-pretty` (same pre-citty extraction pattern)
- [x] `--pretty` calls `setPrettyPrint(true)`, overriding auto-detect
- [x] Strip `--pretty` from argv before citty delegation

### 1.3 Fix `5x skills install` mixed output (`src/commands/skills.handler.ts`)

- [x] Move all `console.log()` calls (progress messages) to `console.error()`

### 1.4 Tests

- [x] `test/output.test.ts`: TTY auto-detect tests (non-TTY → compact, TTY → pretty via `Object.defineProperty` mock)
- [x] `test/commands/skills-install.test.ts`: Progress assertions moved to `stderr`; removed `stdout.indexOf('{\n  "ok"')` workaround; added `--pretty` flag integration test

---

## Phase 2: Template Step Names, Shared Pipe Infrastructure, and Context Enrichment

**Status:** Complete

**Completion gate:** Template frontmatter includes required `step_name` field. `src/pipe.ts` exists with full test coverage. `docs/v1/101-cli-primitives.md` invoke/quality output shapes match actual code. Invoke output includes `run_id`, `step_name`, `phase`, `model`. All tests pass.

### 2.0 Update `docs/v1/101-cli-primitives.md` output contracts

- [x] Update `5x invoke author` return example (line 277-294): change `status` wrapper key to `result`, change flat `tokens_in`/`tokens_out` to nested `tokens: { in, out }`, add `run_id`, `step_name`, `phase`, `model` fields
- [x] Update `5x invoke reviewer` return example (line 350-376): change `verdict` wrapper key to `result`, same token/metadata fixes, add `run_id`, `step_name`, `phase`, `model` fields
- [x] Verify `5x quality run` return example matches actual code shape

### 2.1 Add `step_name` to template frontmatter

- [x] Update `TemplateMetadata` in `src/templates/loader.ts` to include `stepName`:

```typescript
export interface TemplateMetadata {
  name: string;
  version: number;
  variables: string[];
  stepName: string | null;  // NEW — semantic step name for run recording; null if not declared
}
```

- [x] Define a canonical fallback map for known bundled templates (used when `step_name` is missing from on-disk overrides scaffolded before this change):

```typescript
const STEP_NAME_FALLBACKS: Record<string, string> = {
  "author-generate-plan": "author:generate-plan",
  "author-next-phase": "author:implement",
  "author-process-plan-review": "author:fix-review",
  "author-process-impl-review": "author:fix-review",
  "reviewer-plan": "reviewer:review",
  "reviewer-commit": "reviewer:review",
};
```

- [x] Update `parseTemplate()` in `src/templates/loader.ts` to extract `step_name`:
  - If present: validate it is a non-empty string
  - If missing for a known template name: use `STEP_NAME_FALLBACKS[name]` and emit a warning to stderr: `Warning: Template "${name}" is missing "step_name" in frontmatter. Using default "${fallback}". Run "5x init --force" to update your templates.`
  - If missing for an unknown template name: set `stepName: null` (template may not be workflow-aware)

- [x] Update all 6 bundled template `.md` files to add `step_name` to frontmatter:

```yaml
# author-generate-plan.md
name: author-generate-plan
version: 1
variables: [prd_path, plan_path, plan_template_path]
step_name: "author:generate-plan"

# author-next-phase.md
name: author-next-phase
version: 1
variables: [plan_path, phase_number, user_notes]
step_name: "author:implement"

# author-process-plan-review.md
name: author-process-plan-review
version: 1
variables: [review_path, plan_path, user_notes]
step_name: "author:fix-review"

# author-process-impl-review.md
name: author-process-impl-review
version: 1
variables: [review_path, plan_path, user_notes]
step_name: "author:fix-review"

# reviewer-plan.md
name: reviewer-plan
version: 1
variables: [plan_path, review_path, review_template_path]
step_name: "reviewer:review"

# reviewer-commit.md
name: reviewer-commit
version: 1
variables: [commit_hash, review_path, plan_path, review_template_path]
step_name: "reviewer:review"
```

- [x] Update `5x init` template scaffolding: since `5x init` copies bundled templates to `.5x/templates/prompts/`, the new frontmatter flows automatically. Users editing these local copies can customize `step_name` per-project. Older scaffolded copies without `step_name` will use the fallback with a warning.

- [x] Update `renderTemplate()` return type to include `stepName`:

```typescript
export interface RenderedTemplate {
  name: string;
  prompt: string;
  stepName: string | null;   // NEW — from frontmatter; null if not declared
}
```

### 2.2 Create `src/pipe.ts`

- [x] Create shared pipe utility module. `isStdinPiped()` must use `process.stdin.isTTY` directly — do NOT import or reuse anything from `src/utils/stdin.ts` (which has `/dev/tty` fallback and test override logic for interactive prompts):

```typescript
/** Shape of context extracted from an upstream 5x envelope. */
export interface PipeContext {
  /** Run ID from upstream command. */
  runId?: string;
  /** Step name from upstream command (e.g., from template frontmatter). */
  stepName?: string;
  /** Phase identifier. */
  phase?: string;
  /** Template variable fallbacks — eligible string fields from upstream data. */
  templateVars: Record<string, string>;
}

/** Invoke-specific metadata extracted from an upstream invoke envelope. */
export interface InvokeMetadata {
  result: unknown;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  logPath?: string;
}

/**
 * Read and parse an upstream 5x JSON envelope from stdin.
 *
 * Returns null if stdin is not piped (isTTY is true).
 * Throws if stdin is piped but content is not valid JSON or not a
 * successful envelope ({ ok: true }).
 */
export async function readUpstreamEnvelope(): Promise<{
  data: Record<string, unknown>;
  raw: string;
} | null>

/**
 * Extract pipe context (run_id, step_name, phase, template var fallbacks)
 * from an upstream envelope's data payload.
 */
export function extractPipeContext(
  data: Record<string, unknown>,
): PipeContext

/**
 * Detect whether upstream data looks like an invoke result and extract
 * metadata fields if so. Returns null if the shape doesn't match.
 *
 * Detection heuristic: data has `result` (object) AND `session_id` (string).
 */
export function extractInvokeMetadata(
  data: Record<string, unknown>,
): InvokeMetadata | null

/**
 * Check whether stdin is piped (not a TTY).
 * Uses process.stdin.isTTY directly — NOT the prompt helpers in utils/stdin.ts.
 */
export function isStdinPiped(): boolean
```

### 2.3 `extractPipeContext` implementation details

- [x] Extract `run_id` from `data.run_id` (string check)
- [x] Extract `step_name` from `data.step_name` (string check)
- [x] Extract `phase` from `data.phase` (string check)
- [x] Build `templateVars`: iterate `Object.entries(data)`, include entries where `typeof value === "string"`. Apply the following exclusion list to skip internal metadata keys: `run_id`, `session_id`, `log_path`, `cost_usd`, `duration_ms`, `model`, `step_name`, `ok`. Apply template safety check: skip values containing `\n` or `-->`.

### 2.4 Enrich invoke output (`src/commands/invoke.handler.ts`)

- [x] Add fields to `InvokeResult` interface:

```typescript
interface InvokeResult {
  run_id: string;            // NEW — from params.run
  step_name: string | null;  // NEW — from template frontmatter metadata.stepName; null if template has no step_name
  phase: string | null;      // NEW — from parsed vars.phase_number, or null
  model: string;             // NEW — resolved model used for the invocation
  result: unknown;
  session_id: string;
  duration_ms: number;
  tokens: { in: number; out: number };
  cost_usd: number | null;
  log_path: string;
}
```

- [x] Populate `run_id` from `params.run`
- [x] Populate `step_name` from `rendered.stepName` (the template's frontmatter `step_name`; may be `null` for templates without it)
- [x] Populate `phase` from `variables.phase_number ?? null` (where `variables` is the parsed `--var` record)
- [x] Populate `model` from the resolved model variable (already available in `invokeAgent()` at the session creation point)

### 2.5 Tests

- [x] `test/pipe.test.ts` **(NEW)**: Unit tests for:
  - `readUpstreamEnvelope()` with valid invoke envelope
  - `readUpstreamEnvelope()` with valid non-invoke envelope (e.g., quality)
  - `readUpstreamEnvelope()` returns null when stdin is TTY
  - `readUpstreamEnvelope()` throws on invalid JSON
  - `readUpstreamEnvelope()` throws on error envelope (`ok: false`)
  - `extractPipeContext()` extracts run_id, step_name, phase
  - `extractPipeContext()` builds templateVars from string fields only
  - `extractPipeContext()` skips excluded metadata keys (run_id, session_id, log_path, etc.)
  - `extractPipeContext()` skips values with newlines or `-->`
  - `extractPipeContext()` skips non-string values (objects, arrays, numbers)
  - `extractInvokeMetadata()` detects invoke shape and extracts all fields including model
  - `extractInvokeMetadata()` returns null for non-invoke data
- [x] Update template loader tests to assert `stepName` in parsed metadata for all bundled templates
- [x] Test: on-disk template override missing `step_name` for known template -> warns to stderr, uses canonical fallback
- [x] Test: unknown template name with no `step_name` -> `stepName: null`, no warning
- [x] Update invoke handler tests to assert new `run_id`, `step_name`, `phase`, `model` fields in output

---

## Phase 3: Smart Stdin in `run record`

**Status:** Complete

**Completion gate:** `5x invoke author author-next-phase --run R1 | 5x run record` works with zero additional flags — step name, result, metadata, and run_id all auto-extracted from pipe. `5x quality run | 5x run record "quality:check" --run R1` works — step name and run from CLI, result from pipe. CLI flags override piped values. All tests pass.

### 3.0 Extract `recordStepInternal()` from `runV1Record()` (`src/commands/run-v1.handler.ts`)

- [x] Define a structured domain error for recording failures. This preserves machine-readable error codes (`RUN_NOT_FOUND`, `RUN_NOT_ACTIVE`, `MAX_STEPS_EXCEEDED`, `INVALID_JSON`) without coupling to CLI output concerns (`CliError`, `outputError`, stdout):

```typescript
/** Structured recording error — preserves code/detail without CLI side effects. */
export class RecordError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "RecordError";
    this.code = code;
    this.detail = detail;
  }
}
```

- [x] Extract a pure recording helper that performs DB validation + `recordStep()` and returns a structured result object, without calling `outputSuccess()`, `outputError()`, or throwing `CliError`. Throws `RecordError` on validation failures:

```typescript
/** Result from recording a step (no CLI side effects). */
export interface RecordStepResult {
  step_id: number;
  step_name: string;
  phase: string | null;
  iteration: number | null;
  recorded: boolean;
}

/**
 * Record a step in the database. Pure persistence — no stdout, no CliError.
 * Throws RecordError on validation failures (caller decides how to surface).
 */
export async function recordStepInternal(
  params: RunRecordParams & { run: string; stepName: string; result: string },
): Promise<RecordStepResult>
```

- [x] `runV1Record()` becomes a thin CLI wrapper: calls `recordStepInternal()`, catches `RecordError` and maps to `outputError()` (preserving the existing `code`/`detail` contract), calls `outputSuccess()` with the result.
- [x] This helper is also used by Phase 6 (`--record` on invoke/quality). The `--record` caller catches `RecordError`, logs `err.code: err.message` to stderr, and sets `process.exitCode = 1`.

### 3.1 Relax `run record` argument requirements (`src/commands/run-v1.ts`)

- [x] Change `stepName` positional from `required: true` to `required: false`
- [x] Change `result` from `required: true` to `required: false`
- [x] Change `run` from `required: true` to `required: false`

### 3.2 Add pipe ingestion to `run record` handler (`src/commands/run-v1.handler.ts`)

- [x] Update `RunRecordParams`:

```typescript
export interface RunRecordParams {
  stepName?: string;     // can come from pipe (template's step_name) or positional
  run?: string;          // can come from pipe
  result?: string;       // can come from pipe
  phase?: string;
  iteration?: number;
  sessionId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  logPath?: string;
}
```

- [x] At the top of `runV1Record()`, before any DB operations, read pipe when stdin is available. The condition is: stdin is piped AND `--result -` was not specified (since `-` consumes stdin for raw result). This is NOT gated on whether any particular field is present — the envelope is always parsed when stdin is available, and each field is merged individually. This ensures partial override scenarios work: `--result @./file.json` provides result from a file while `run_id` and `step_name` still come from the pipe.

```typescript
// Track whether --result - was specified (consumes stdin for raw result)
const rawResult = params.result;
const stdinConsumedByResult = rawResult === "-";

// Resolve raw --result first (existing behavior: "-" for stdin, "@path" for file)
if (params.result) {
  params.result = await readResultJson(params.result);
}

// If stdin is piped and not consumed by --result -, parse upstream envelope
if (!stdinConsumedByResult && isStdinPiped()) {
  const upstream = await readUpstreamEnvelope();
  if (upstream) {
    const ctx = extractPipeContext(upstream.data);
    const invoke = extractInvokeMetadata(upstream.data);

    // Auto-populate from pipe context (CLI flags take precedence via ??=)
    params.run ??= ctx.runId;
    params.stepName ??= ctx.stepName;
    params.phase ??= ctx.phase;

    if (invoke) {
      // Invoke envelope: extract result + all metadata
      params.result ??= JSON.stringify(invoke.result);
      params.sessionId ??= invoke.sessionId;
      params.model ??= invoke.model;
      params.durationMs ??= invoke.durationMs;
      params.tokensIn ??= invoke.tokensIn;
      params.tokensOut ??= invoke.tokensOut;
      params.costUsd ??= invoke.costUsd;
      params.logPath ??= invoke.logPath;
    } else {
      // Non-invoke envelope: use full data as result JSON
      params.result ??= JSON.stringify(upstream.data);
    }
  }
}

// Validate required params are now resolved (after merge)
if (!params.run) {
  outputError("INVALID_ARGS", "--run is required (provide it or pipe from an upstream command)");
}
if (!params.stepName) {
  outputError("INVALID_ARGS", "Step name is required (provide it as a positional arg or pipe from invoke)");
}
if (!params.result) {
  outputError("INVALID_ARGS", "--result is required (provide it or pipe from an upstream command)");
}
```

### 3.3 Tests (`test/commands/run-record-pipe.test.ts` **NEW**)

- [x] Test: pipe invoke envelope -> record auto-extracts all fields (run_id, step_name, result, session_id, model, duration_ms, tokens, cost_usd, log_path)
- [x] Test: pipe quality envelope -> record uses JSON.stringify(data) as result, requires explicit step name and --run
- [x] Test: CLI flags override piped values (e.g., `--phase 2` overrides piped `phase: "1"`)
- [x] Test: positional step name overrides piped step_name
- [x] Test: error when stdin not piped and required params missing
- [x] Test: error when piped envelope is `ok: false`
- [x] Test: `--result @./file.json` with piped envelope -> result from file, run_id/step_name from pipe
- [x] Test: `--result -` consumes stdin for raw result (not envelope parsing)
- [x] Test: `--result '{"inline":"json"}'` with piped envelope -> result from inline, context from pipe
- [x] Test: pipe with explicit --run (partial override — run from CLI, result from pipe)

---

## Phase 4: Invoke Reads Upstream Context from Stdin

**Completion gate:** `5x run init --plan plan.md | 5x invoke author author-next-phase --var phase_number=1` works without `--run`. Template variable `plan_path` is auto-populated from upstream `data.plan_path`. All tests pass.

### 4.1 Relax `--run` requirement in invoke (`src/commands/invoke.ts`)

- [ ] Change `run` arg from `required: true` to `required: false`
- [ ] Handler will validate that `run` is resolved (from flag or stdin) before proceeding

### 4.2 Add upstream context reading to invoke handler (`src/commands/invoke.handler.ts`)

- [ ] At the top of `invokeAgent()`, before `validateRunId()`:

```typescript
let pipeContext: PipeContext | undefined;

// Read upstream context from stdin if --run not provided
// and no --var uses @- (which would consume stdin)
const hasStdinVar = Array.isArray(params.vars)
  ? params.vars.some(v => v.includes("=@-"))
  : params.vars?.includes("=@-") ?? false;

if (!params.run && !hasStdinVar && isStdinPiped()) {
  const upstream = await readUpstreamEnvelope();
  if (upstream) {
    pipeContext = extractPipeContext(upstream.data);
    params.run ??= pipeContext.runId;
  }
}

if (!params.run) {
  outputError("INVALID_ARGS", "--run is required (provide it or pipe from an upstream command)");
}
validateRunId(params.run);
```

- [ ] When parsing template variables, merge pipe context vars as fallbacks:

```typescript
const explicitVars = parseVars(params.vars);
const variables = pipeContext
  ? { ...pipeContext.templateVars, ...explicitVars }  // explicit --var wins
  : explicitVars;
```

### 4.3 Tests (`test/commands/invoke-pipe.test.ts` **NEW**)

- [ ] Test: pipe run init envelope -> invoke picks up `data.run_id` as --run
- [ ] Test: pipe run init envelope -> invoke auto-injects `data.plan_path` as template variable
- [ ] Test: explicit `--var plan_path=other.md` overrides piped `data.plan_path`
- [ ] Test: explicit `--run R2` overrides piped `data.run_id`
- [ ] Test: error when no --run and stdin is not piped
- [ ] Test: `--var key=@-` prevents upstream context reading (stdin consumed for var)
- [ ] Test: non-string data fields are not injected as template vars
- [ ] Test: values with newlines in data fields are skipped for template var injection
- [ ] Test: excluded metadata keys (session_id, log_path, etc.) are not injected as template vars

---

## Phase 5: `--var key=@-` and `--var key=@path`

**Completion gate:** `--var diff=@-` reads from stdin. `--var diff=@./file.txt` reads from file. Only one `@-` per invocation. All tests pass.

### 5.1 Extend `parseVars()` in `src/commands/invoke.handler.ts`

- [ ] After splitting `key=value`, check if `value` starts with `@`:
  - `@-` -> read from stdin (`Bun.stdin.stream()` to EOF)
  - `@<path>` -> read from file (`readFileSync(resolve(path), "utf-8")`)
- [ ] Enforce at most one `@-` var per invocation (error if multiple)
- [ ] `parseVars()` becomes async (returns `Promise<Record<string, string>>`)
- [ ] Update callers to await the result

### 5.2 Interaction with upstream context reading

- [ ] In `invokeAgent()`, detect `@-` vars BEFORE deciding whether to read stdin for upstream context:
  - If any `--var` uses `@-`, stdin is consumed for that var — skip upstream envelope reading
  - If no `--var` uses `@-`, stdin is available for upstream context extraction (Phase 4 logic)

### 5.3 Tests

- [ ] Test: `--var diff=@-` reads value from piped stdin
- [ ] Test: `--var diff=@./test-fixture.txt` reads value from file
- [ ] Test: `--var diff=@./nonexistent.txt` errors with clear message
- [ ] Test: multiple `@-` vars errors ("only one --var can read from stdin")
- [ ] Test: `@-` var prevents upstream context reading
- [ ] Test: `@path` vars work alongside upstream context reading (no conflict)

---

## Phase 6: `--record` Flag on Invoke and Quality

**Completion gate:** `5x invoke author author-next-phase --run R1 --record` auto-records using the template's `step_name`. `5x quality run --run R1 --record` auto-records as `quality:check`. Optional `--record-step` overrides the default. Recording uses `recordStepInternal()` (no double envelope). All tests pass.

### 6.1 Add `--record` to invoke (`src/commands/invoke.ts`)

- [ ] Add args:

```typescript
record: {
  type: "boolean",
  description: "Auto-record the result as a run step (uses template's step_name)",
},
'record-step': {
  type: "string",
  description: 'Override step name for recording (default: from template frontmatter)',
},
phase: {
  type: "string",
  description: "Phase identifier (used with --record)",
},
iteration: {
  type: "string",
  description: "Iteration number (used with --record)",
},
```

- [ ] Pass new params through to `InvokeParams`:

```typescript
export interface InvokeParams {
  // ... existing fields ...
  record?: boolean;       // NEW
  recordStep?: string;    // NEW — optional override for template's step_name
  phase?: string;         // NEW (for record metadata)
  iteration?: number;     // NEW (for record metadata)
}
```

### 6.2 Auto-record in invoke handler (`src/commands/invoke.handler.ts`)

- [ ] After `outputSuccess(output)`, if `params.record` is truthy, call `recordStepInternal()` (NOT `runV1Record()`):

```typescript
if (params.record) {
  // Step name: --record-step override, or template's step_name from frontmatter
  const stepName = params.recordStep ?? rendered.stepName;
  if (!stepName) {
    outputError("INVALID_ARGS", "--record requires a step name. Provide --record-step or add step_name to the template frontmatter.");
  }

  try {
    await recordStepInternal({
      run: params.run,
      stepName,
      result: JSON.stringify(structured),
      phase: params.phase ?? variables.phase_number,
      iteration: params.iteration,
      sessionId: runResult.sessionId,
      model,
      durationMs: runResult.durationMs,
      tokensIn: runResult.tokens.in,
      tokensOut: runResult.tokens.out,
      costUsd: runResult.costUsd ?? undefined,
      logPath: logPath ?? undefined,
    });
  } catch (err) {
    // Recording is a side effect — primary envelope already written.
    // Warn on stderr with structured code, set non-zero exit via process.exitCode.
    if (err instanceof RecordError) {
      console.error(`Warning: failed to record step [${err.code}]: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: failed to record step: ${msg}`);
    }
    process.exitCode = 1;
  }
}
```

- [ ] Import `recordStepInternal` from `run-v1.handler.ts`

### 6.3 Add `--record` and `--run` to quality (`src/commands/quality-v1.ts`)

- [ ] Add args:

```typescript
record: {
  type: "boolean",
  description: 'Auto-record the result as a run step (default step name: "quality:check")',
},
'record-step': {
  type: "string",
  description: 'Override step name for recording (default: "quality:check")',
},
run: {
  type: "string",
  description: "Run ID (required when using --record)",
},
phase: {
  type: "string",
  description: "Phase identifier (used with --record)",
},
```

### 6.4 Auto-record in quality handler (`src/commands/quality-v1.handler.ts`)

- [ ] Accept new params (`record`, `recordStep`, `run`, `phase`) in the handler signature
- [ ] After `outputSuccess(...)`, if `record` is truthy:
  - Validate `run` is provided (error: "--run is required when using --record")
  - Call `recordStepInternal()` with step_name from `recordStep` (defaulting to `"quality:check"`), result as the full quality data JSON
  - Wrap in try/catch with stderr warning on failure (same pattern as invoke)

### 6.5 Tests

- [ ] Test: `invoke --record` auto-records using template's `step_name` (e.g., `author:implement` for `author-next-phase`)
- [ ] Test: `invoke --record --record-step "custom:step"` overrides template's step_name
- [ ] Test: `invoke --record` populates all metadata (session_id, model, duration, tokens, cost, log_path)
- [ ] Test: `invoke --record --phase 1` passes phase to record
- [ ] Test: `quality run --record --run R1` records with default step name "quality:check"
- [ ] Test: `quality run --record --record-step "quality:gates" --run R1` uses custom step name
- [ ] Test: `quality run --record` without `--run` errors
- [ ] Test: `--record` still outputs JSON envelope to stdout (recording is a side effect, only one envelope)
- [ ] Test: `--record` failure (e.g., run not found) does not suppress the invoke output — emits warning to stderr, sets non-zero exit code

---

## Phase 7: Update Example Script

**Completion gate:** `examples/author-review-loop.sh` uses new composability features. Script is shorter and clearer. Still functions correctly.

### 7.1 Rewrite `examples/author-review-loop.sh`

- [ ] Remove the `unwrap()` helper function (no longer needed for recording)
- [ ] Use `--record` on invoke calls where possible
- [ ] Use pipe pattern for quality -> record
- [ ] Keep `jq` for branching logic (inspecting `.data.result.result` to decide next action) — this is the correct tool for value extraction in shell scripts
- [ ] Add comments showing the composability patterns being used
- [ ] Update the header comment to reference 5x.toml instead of 5x.config.js

### 7.2 Before/after comparison

**Before** (current — 8 lines per record call):
```bash
AUTHOR_OUT=$(5x invoke author author-next-phase --run "$RUN_ID" --var ...)
AUTHOR=$(unwrap "$AUTHOR_OUT")
5x run record "author:implement" --run "$RUN_ID" --phase "$PHASE" \
  --result "$(echo "$AUTHOR" | jq -c '.result')" \
  --session-id "$(echo "$AUTHOR" | jq -r '.session_id')" \
  --duration-ms "$(echo "$AUTHOR" | jq -r '.duration_ms')" \
  --tokens-in "$(echo "$AUTHOR" | jq -r '.tokens.in')" \
  --tokens-out "$(echo "$AUTHOR" | jq -r '.tokens.out')" \
  --log-path "$(echo "$AUTHOR" | jq -r '.log_path')" > /dev/null
```

**After — `--record` style** (2 lines):
```bash
AUTHOR_OUT=$(5x invoke author author-next-phase --run "$RUN_ID" --record \
  --var "plan_path=$PLAN" --var "phase_number=$PHASE")
AUTHOR_RESULT=$(echo "$AUTHOR_OUT" | jq -r '.data.result.result')
```

**After — pipe style** (3 lines):
```bash
AUTHOR_OUT=$(5x invoke author author-next-phase --run "$RUN_ID" \
  --var "plan_path=$PLAN" --var "phase_number=$PHASE")
echo "$AUTHOR_OUT" | 5x run record --phase "$PHASE" > /dev/null
AUTHOR_RESULT=$(echo "$AUTHOR_OUT" | jq -r '.data.result.result')
```

**After — full pipe chain** (fire-and-forget, no branching):
```bash
5x run init --plan "$PLAN" --allow-dirty | \
  5x invoke author author-next-phase --var "phase_number=$PHASE" | \
  5x run record
```

---

## Dependency Graph

```
Phase 1 (TTY + skills fix) ────┐
                                ├──→ Phase 3 (record stdin + helper) ──→ Phase 6 (--record)
Phase 2 (pipe.ts + templates) ──┤                                             │
                                ├──→ Phase 4 (invoke stdin) ──────────────────┤
                                │                                              │
                                └──→ Phase 5 (--var @-/@path) ────────────────┘
                                                                               │
                                                                               ▼
                                                                      Phase 7 (example)
```

Phases 1 and 2 can be implemented in parallel (no interdependencies). Phases 3, 4, 5 all depend on Phase 2 (`src/pipe.ts` and template step names). Phase 6 depends on Phases 3 and 4 (needs `recordStepInternal` from Phase 3 and invoke handler changes from Phase 4). Phase 7 depends on all preceding phases.

## Risk Assessment

**Stdin consumption conflicts.** The priority order (explicit `--result -` > `--var @-` > automatic context) is well-defined. `--result -` consumes stdin for raw result, preventing envelope parsing. `--result @path` or `--result '{"json":"..."}` do NOT consume stdin — the pipe is still available for context extraction (`run_id`, `step_name`, etc.), with the explicit result taking precedence via `??=`. Only `--result -` and `--var key=@-` conflict with pipe envelope parsing since they consume the stdin stream.

**Template variable injection safety.** Auto-injecting upstream `data.*` fields as template vars could theoretically expose unexpected values to templates. Mitigated by: only string values, explicit exclusion list for metadata keys, template safety validation (no newlines/`-->`), and `--var` always overrides. Additionally, template rendering already rejects undeclared variables — only variables listed in the template's frontmatter `variables` array are substituted, so injected fields that don't match a declared variable are silently ignored.

**`--record` error handling.** If invoke succeeds but recording fails (e.g., run not found, DB error), the invoke result is still valuable. The `--record` path uses `recordStepInternal()` (not the CLI handler), wrapped in try/catch. Failures emit a warning to stderr and set `process.exitCode = 1`, but never suppress or corrupt the primary JSON envelope on stdout. This ensures the command's output is always usable by downstream consumers.

**`--record` produces exactly one envelope.** Because `recordStepInternal()` is a pure persistence function with no stdout side effects, `invoke --record` always produces exactly one JSON envelope (the invoke result). The recording is invisible to stdout consumers. This is verified by tests.

**Template `step_name` consistency across versions.** When templates are updated (e.g., via `5x upgrade`), the `step_name` in the bundled template may differ from the user's local copy in `.5x/templates/prompts/`. The upgrade process preserves user-modified templates (only overwrites with `--force`), so user-customized step names are not silently changed. If the bundled step name convention evolves, the upgrade command should warn about step name mismatches.

**Step name collisions across templates.** Multiple templates may share the same `step_name` (e.g., `reviewer-plan` and `reviewer-commit` both use `reviewer:review`). This is by design — they represent the same semantic step. The DB UNIQUE constraint `(run_id, step_name, phase, iteration)` prevents collisions as long as the caller provides distinct `phase` or `iteration` values for each invocation within the same run. If a workflow invokes two templates with the same step name, same phase, and same iteration, the second insert will fail with a constraint violation — this is correct behavior (it indicates a workflow logic error).
