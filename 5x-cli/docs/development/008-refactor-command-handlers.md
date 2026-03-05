# Refactor: Decouple Command Handlers from CLI Framework

**Version:** 1.1
**Created:** March 5, 2026
**Status:** Draft
**Review:** `docs/development/reviews/2026-03-05-008-refactor-command-handlers-plan-review.md`

## Overview

Current behavior: All 8 command files (`run-v1.ts`, `invoke.ts`, `prompt.ts`, `diff.ts`, `quality-v1.ts`, `plan-v1.ts`, `init.ts`, `worktree.ts`) embed business logic directly inside citty `defineCommand` run handlers. Args are read via `ctx.args` with citty's hyphenated naming convention (`args["allow-dirty"]`, `args["show-reasoning"]`). Numeric args are strings that each command parses independently. Boilerplate setup (project root, config, DB, migrations) is repeated across handlers.

Desired behavior: Each command file becomes a thin citty adapter that maps `ctx.args` to a typed params object and calls an exported handler function. All business logic lives in `*.handler.ts` files with camelCase typed interfaces. Shared utilities (stdin I/O, numeric parsing, project context setup) are extracted to reusable modules.

Why this change: We intend to replace citty with commander.js for richer help text, examples, and argument parsing. This refactor isolates the ~320 lines of citty-specific code from ~1,574 lines of business logic, so the future framework swap touches only adapter files and `bin.ts`. Handler functions also become directly unit-testable without subprocess overhead.

## Design Decisions

**Handler files are co-located with adapter files.** Each command gets `foo.ts` (citty adapter) and `foo.handler.ts` (business logic). This keeps the mapping obvious and avoids a separate `handlers/` directory that splits the mental model.

**Params interfaces use camelCase with semantic types.** Handlers accept parsed, validated values — `{ tail?: number }` not `{ tail?: string }`. The adapter layer performs string→number parsing using `src/utils/parse-args.ts` utilities. When commander.js arrives with its own `.argParser()`, the adapter changes but handler signatures remain identical. This is the core invariant that makes the framework swap safe.

**Two context helpers, not one, eliminate repeated boilerplate.** The `resolveProjectRoot() → loadConfig()` sequence appears in all commands; the full `→ getDb() → runMigrations()` chain appears in 5 commands. Two helpers cover both cases:
- `resolveProjectContext({ startDir?, providerNames? }) → { projectRoot, config }` — for commands that don't need DB (`diff`, `plan`, `quality`, `invoke`).
- `resolveDbContext({ startDir?, providerNames?, migrate? }) → { projectRoot, config, db }` — for commands that need DB (`run`, `worktree`). `migrate` defaults to `true`.

The `startDir` parameter matches `resolveProjectRoot(startDir?)` semantics. `providerNames` is a first-class parameter because `loadConfig()` warning suppression is already relied on by `invoke`.

**Stdin utilities extracted to `src/utils/stdin.ts`.** The 100 lines of TTY detection, line reading, and pipe reading in `prompt.ts` are general-purpose I/O utilities, not prompt-specific business logic.

**Numeric parsers extracted to `src/utils/parse-args.ts`.** `parseIntArg` and `parseFloatArg` exist because citty can't parse numbers. They are adapter-layer helpers: adapters call them to convert raw CLI strings into semantic types before passing to handlers. Commander.js has `.argParser()` which may replace them, but they provide a single deprecation point.

**Handler module boundary: no `citty` imports.** Handler files may import `output*`, DB, git, template, provider, and utility modules — but never `citty` or any CLI framework module. This is the enforceable rule that guarantees handlers survive a framework swap.

**Tests are unaffected.** 7 of 8 test files are subprocess-based (spawn `bun run bin.ts`). Only `init-skills.test.ts` imports directly — one import path changes. No test logic changes.

**`outputSuccess`/`outputError` stay in handlers.** These are part of the CLI output contract, not framework-specific. Handlers own the decision of what to output. Adapters are purely structural.

## Phase 1: Extract Shared Utilities

**Completion gate:** `src/utils/stdin.ts` and `src/utils/parse-args.ts` exist, are imported by handler files, and all tests pass. Unit tests for `parseIntArg`/`parseFloatArg` exist in `test/utils/parse-args.test.ts`.

- [x] Create `src/utils/stdin.ts` extracting from `src/commands/prompt.ts:19-120`:

```typescript
// src/utils/stdin.ts

/** Check if stdin is a TTY (respects 5X_FORCE_TTY and NODE_ENV=test). */
export function isTTY(): boolean;

/** Sentinel returned by readLine when stdin receives EOF (Ctrl+D). */
export const EOF = Symbol("EOF");

/** Sentinel returned by readLine when SIGINT is received. */
export const SIGINT = Symbol("SIGINT");

/** Read a single line from stdin. Returns EOF on close, SIGINT on interrupt. */
export function readLine(): Promise<string | typeof EOF | typeof SIGINT>;

/** Read all remaining stdin until EOF (Ctrl+D). */
export function readAll(): Promise<string>;

/** Read stdin pipe (non-TTY) to completion. */
export function readStdinPipe(): Promise<string>;
```

  Module-level state (`stdinBuffer`, `stdinEnded`) moves with the functions.

- [x] Create `src/utils/parse-args.ts` extracting from `src/commands/run-v1.ts:44-98`:

```typescript
// src/utils/parse-args.ts

/** Parse and validate an integer CLI argument. Throws INVALID_ARGS on failure. */
export function parseIntArg(
  value: string,
  flag: string,
  opts?: { positive?: boolean },
): number;

/** Parse and validate a float CLI argument. Throws INVALID_ARGS on failure. */
export function parseFloatArg(
  value: string,
  flag: string,
  opts?: { nonNegative?: boolean },
): number;

/**
 * Parse --timeout as a positive integer (seconds).
 * Returns undefined if not provided (undefined/null/empty).
 * Throws INVALID_ARGS on invalid input.
 */
export function parseTimeout(
  raw: string | number | undefined,
): number | undefined;
```

- [x] Create `src/commands/context.ts`:

```typescript
// src/commands/context.ts
import type { Database } from "bun:sqlite";
import type { FiveXConfig } from "../config.js";

export interface ProjectContext {
  projectRoot: string;
  config: FiveXConfig;
}

export interface DbContext extends ProjectContext {
  db: Database;
}

/**
 * Resolve project root and load config. For commands that don't need DB
 * (diff, plan, quality, invoke).
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 */
export async function resolveProjectContext(opts?: {
  startDir?: string;
  providerNames?: Set<string>;
}): Promise<ProjectContext>;

/**
 * Resolve project root, load config, open DB, and run migrations.
 * For commands that need DB (run, worktree).
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 * @param opts.migrate - Run DB migrations (default: true)
 */
export async function resolveDbContext(opts?: {
  startDir?: string;
  providerNames?: Set<string>;
  migrate?: boolean;
}): Promise<DbContext>;
```

## Phase 2: Extract Handler — `prompt`

**Completion gate:** `src/commands/prompt.handler.ts` exports `promptChoose`, `promptConfirm`, `promptInput`. `prompt.ts` is a thin adapter. All prompt tests pass.

- [ ] Create `src/commands/prompt.handler.ts`:

```typescript
// src/commands/prompt.handler.ts

export interface ChooseParams {
  message: string;
  options: string;     // comma-separated, parsed inside handler
  default?: string;
}

export interface ConfirmParams {
  message: string;
  default?: string;    // "yes"|"no"|"y"|"n"|"true"|"false"
}

export interface InputParams {
  message: string;
  multiline?: boolean;
}

export async function promptChoose(params: ChooseParams): Promise<void>;
export async function promptConfirm(params: ConfirmParams): Promise<void>;
export async function promptInput(params: InputParams): Promise<void>;
```

  Each function contains the full business logic currently in the corresponding `defineCommand` run handler (lines 147-247, 266-342, 362-387). They import from `../utils/stdin.js` instead of using local helpers.

- [ ] Slim `src/commands/prompt.ts` to adapter-only:

```typescript
// src/commands/prompt.ts — adapter (~40 lines)
import { defineCommand } from "citty";
import { promptChoose, promptConfirm, promptInput } from "./prompt.handler.js";

const chooseCmd = defineCommand({
  meta: { name: "choose", description: "Present a choice prompt" },
  args: { /* unchanged */ },
  run: ({ args }) => promptChoose({
    message: args.message as string,
    options: args.options as string,
    default: args.default as string | undefined,
  }),
});
// ... confirmCmd, inputCmd similarly thin
```

## Phase 3: Extract Handler — `run-v1`

**Completion gate:** `src/commands/run-v1.handler.ts` exports `runV1Init`, `runV1State`, `runV1Record`, `runV1Complete`, `runV1Reopen`, `runV1List`. `run-v1.ts` is a thin adapter. All run tests pass.

- [ ] Create `src/commands/run-v1.handler.ts`:

```typescript
// src/commands/run-v1.handler.ts

export interface RunInitParams {
  plan: string;
  command?: string;
  allowDirty?: boolean;
}

export interface RunStateParams {
  run?: string;
  plan?: string;
  tail?: number;       // adapter parses string→number via parseIntArg
  sinceStep?: number;  // adapter parses string→number via parseIntArg
}

export interface RunRecordParams {
  stepName: string;
  run: string;
  result: string;      // raw JSON string, "-" for stdin, "@path" for file
  phase?: string;
  iteration?: number;  // adapter parses
  sessionId?: string;
  model?: string;
  tokensIn?: number;   // adapter parses
  tokensOut?: number;   // adapter parses
  costUsd?: number;     // adapter parses via parseFloatArg
  durationMs?: number;  // adapter parses
  logPath?: string;
}

export interface RunCompleteParams {
  run: string;
  status?: "completed" | "aborted";  // semantic enum, default "completed"
  reason?: string;
}

export interface RunReopenParams {
  run: string;
}

export interface RunListParams {
  plan?: string;
  status?: string;
  limit?: number;      // adapter parses
}

export async function runV1Init(params: RunInitParams): Promise<void>;
export async function runV1State(params: RunStateParams): Promise<void>;
export async function runV1Record(params: RunRecordParams): Promise<void>;
export async function runV1Complete(params: RunCompleteParams): Promise<void>;
export async function runV1Reopen(params: RunReopenParams): Promise<void>;
export async function runV1List(params: RunListParams): Promise<void>;
```

  Helpers that move into the handler file:
  - `readResultJson()` (from `run-v1.ts:100-117`)
  - `getMaxStepsPerRun()` (from `run-v1.ts:119-139`)
  - `formatStep()` (from `run-v1.ts:321-337`)

  `resolveDbContext()` replaces the repeated project-root/config/DB/migration boilerplate in `runV1State`, `runV1Record`, `runV1Complete`, `runV1Reopen`, `runV1List`. `runV1Init` has a unique setup flow (lock-first, conditional DB open) so it calls `resolveProjectRoot()` and `loadConfig()` directly.

- [ ] Slim `src/commands/run-v1.ts` to adapter-only:

```typescript
// src/commands/run-v1.ts — adapter (~130 lines, down from 698)
import { parseIntArg, parseFloatArg } from "../utils/parse-args.js";

const initCmd = defineCommand({
  meta: { name: "init", description: "Initialize or resume a run for a plan" },
  args: { /* unchanged */ },
  run: ({ args }) => runV1Init({
    plan: args.plan as string,
    command: args.command as string | undefined,
    allowDirty: args["allow-dirty"] as boolean,
  }),
});

const stateCmd = defineCommand({
  // ...
  run: ({ args }) => runV1State({
    run: args.run as string | undefined,
    plan: args.plan as string | undefined,
    tail: args.tail ? parseIntArg(args.tail, "--tail", { positive: true }) : undefined,
    sinceStep: args["since-step"] ? parseIntArg(args["since-step"], "--since-step") : undefined,
  }),
});
// ... recordCmd (parses numeric fields), completeCmd, reopenCmd, listCmd
```

## Phase 4: Extract Handler — `invoke`

**Completion gate:** `src/commands/invoke.handler.ts` exports `invokeAgent`. `invoke.ts` is a thin adapter. All invoke tests pass.

- [ ] Create `src/commands/invoke.handler.ts`:

```typescript
// src/commands/invoke.handler.ts

export interface InvokeParams {
  template: string;
  run: string;
  vars?: string | string[];  // --var key=value, repeatable
  model?: string;
  workdir?: string;
  session?: string;
  timeoutSeconds?: number;   // adapter parses string→number
  quiet?: boolean;
  showReasoning?: boolean;
  authorProvider?: string;
  reviewerProvider?: string;
  opencodeUrl?: string;
}

export type InvokeRole = "author" | "reviewer";

export async function invokeAgent(role: InvokeRole, params: InvokeParams): Promise<void>;
```

  Helpers that move into the handler file:
  - `validateRunId()` (from `invoke.ts:62-70`)
  - `parseVars()` (from `invoke.ts:74-94`)
  - `invokeStreamed()` (from `invoke.ts:122-163`)
  - `InvokeResult` interface (from `invoke.ts:46-53`)
  - `SAFE_RUN_ID` regex (from `invoke.ts:60`)

  `parseTimeout()` stays in the adapter (or moves to `parse-args.ts`) since it converts a CLI string to `number | undefined` — the handler receives `timeoutSeconds?: number`.

- [ ] Slim `src/commands/invoke.ts` to adapter-only:

```typescript
// src/commands/invoke.ts — adapter (~80 lines, down from 472)
import { parseTimeout } from "../utils/parse-args.js";

const authorCmd = defineCommand({
  meta: { name: "author", description: "Invoke an author agent with a template" },
  args: sharedArgs,
  run: ({ args }) => invokeAgent("author", {
    template: args.template as string,
    run: args.run as string,
    vars: args.var as string | string[] | undefined,
    model: args.model as string | undefined,
    workdir: args.workdir as string | undefined,
    session: args.session as string | undefined,
    timeoutSeconds: parseTimeout(args.timeout),
    quiet: args.quiet as boolean | undefined,
    showReasoning: args["show-reasoning"] as boolean | undefined,
    authorProvider: args["author-provider"] as string | undefined,
    reviewerProvider: args["reviewer-provider"] as string | undefined,
    opencodeUrl: args["opencode-url"] as string | undefined,
  }),
});
```

## Phase 5: Extract Handlers — `diff`, `quality-v1`, `plan-v1`

**Completion gate:** Each command has a handler file. All tests pass.

- [ ] Create `src/commands/diff.handler.ts`:

```typescript
export interface DiffParams {
  since?: string;
  stat?: boolean;
}

export async function runDiff(params: DiffParams): Promise<void>;
```

  Helpers that move into the handler file:
  - `gitRun()` (from `diff.ts:19-34`)
  - `parseStatSummary()` (from `diff.ts:37-60`)
  - `parseFileNames()` (from `diff.ts:63-68`)

- [ ] Slim `src/commands/diff.ts` to adapter-only (~20 lines).

- [ ] Create `src/commands/quality-v1.handler.ts`:

```typescript
export async function runQuality(): Promise<void>;
```

  Uses `resolveProjectContext()`. No params needed (reads config internally). Does not need DB.

- [ ] Slim `src/commands/quality-v1.ts` to adapter-only (~15 lines).

- [ ] Create `src/commands/plan-v1.handler.ts`:

```typescript
export interface PlanPhasesParams {
  path: string;
}

export async function planPhases(params: PlanPhasesParams): Promise<void>;
```

- [ ] Slim `src/commands/plan-v1.ts` to adapter-only (~15 lines).

## Phase 6: Extract Handlers — `init`, `worktree`

**Completion gate:** Each command has a handler file. `init-skills.test.ts` imports from handler file. All tests pass.

- [ ] Create `src/commands/init.handler.ts`:

```typescript
export interface InitParams {
  force?: boolean;
}

export async function initScaffold(params: InitParams): Promise<void>;

// Re-exported for testing (previously exported from init.ts)
export { generateConfigContent, ensureTemplateFiles, ensurePromptTemplates, ensureGitignore };

// ensureSkills is re-exported from skills/loader.ts — keep available for
// test/commands/init-skills.test.ts which imports it from init.
export { ensureSkills } from "../skills/loader.js";
```

  All helper functions move from `init.ts` into the handler:
  - `generateConfigContent()` (from `init.ts:14-66`)
  - `ensureTemplateFiles()` (from `init.ts:68-108`)
  - `ensurePromptTemplates()` (from `init.ts:115-146`)
  - `ensureGitignore()` (from `init.ts:152-177`)

- [ ] Slim `src/commands/init.ts` to adapter-only (~15 lines).

- [ ] Create `src/commands/worktree.handler.ts`:

```typescript
export interface WorktreeCreateParams {
  plan: string;
  branch?: string;
}

export interface WorktreeRemoveParams {
  plan: string;
  force?: boolean;
}

export async function worktreeCreate(params: WorktreeCreateParams): Promise<void>;
export async function worktreeRemove(params: WorktreeRemoveParams): Promise<void>;
export async function worktreeList(): Promise<void>;
```

  Helpers that move into the handler file:
  - `worktreeDir()` (from `worktree.ts:38-42`)

  Uses `resolveDbContext()` for the project-root/config/DB/migration boilerplate.

- [ ] Slim `src/commands/worktree.ts` to adapter-only (~50 lines).

- [ ] Update `test/commands/init-skills.test.ts` import:

```typescript
// Before:
import { ensureSkills as ensureSkillsFromInit } from "../../src/commands/init.js";
// After:
import { ensureSkills as ensureSkillsFromInit } from "../../src/commands/init.handler.js";
```

## Phase 7: Verify

**Completion gate:** Full test suite, typecheck, and lint pass. No business logic remains in citty adapter files.

- [ ] Run `bun test` — all tests pass
- [ ] Run `bunx --bun tsc --noEmit` — no type errors
- [ ] Run `bunx --bun @biomejs/biome check src/ test/` — no lint errors
- [ ] Manual verification: each adapter file contains only `defineCommand`, args definitions, arg parsing/normalization (string→number via `parse-args.ts`), and a call to the handler function. No IO side effects, no DB calls, no git operations, no `outputSuccess`/`outputError` calls. No handler file imports `citty`.

## Files Touched

| File | Change |
|------|--------|
| `src/utils/stdin.ts` | **New** — TTY detection, line reading, pipe reading |
| `src/utils/parse-args.ts` | **New** — `parseIntArg`, `parseFloatArg` |
| `src/commands/context.ts` | **New** — `resolveProjectContext()`, `resolveDbContext()` shared setup |
| `src/commands/prompt.handler.ts` | **New** — `promptChoose`, `promptConfirm`, `promptInput` |
| `src/commands/run-v1.handler.ts` | **New** — `runV1Init`, `runV1State`, `runV1Record`, `runV1Complete`, `runV1Reopen`, `runV1List` |
| `src/commands/invoke.handler.ts` | **New** — `invokeAgent` |
| `src/commands/diff.handler.ts` | **New** — `runDiff` |
| `src/commands/quality-v1.handler.ts` | **New** — `runQuality` |
| `src/commands/plan-v1.handler.ts` | **New** — `planPhases` |
| `src/commands/init.handler.ts` | **New** — `initScaffold`, `generateConfigContent`, `ensureTemplateFiles`, `ensurePromptTemplates`, `ensureGitignore`, re-exports `ensureSkills` |
| `src/commands/worktree.handler.ts` | **New** — `worktreeCreate`, `worktreeRemove`, `worktreeList` |
| `src/commands/prompt.ts` | **Modified** — Slim to adapter (~40 lines, from 404) |
| `src/commands/run-v1.ts` | **Modified** — Slim to adapter (~130 lines, from 698) |
| `src/commands/invoke.ts` | **Modified** — Slim to adapter (~80 lines, from 472) |
| `src/commands/diff.ts` | **Modified** — Slim to adapter (~20 lines, from 167) |
| `src/commands/quality-v1.ts` | **Modified** — Slim to adapter (~15 lines, from 69) |
| `src/commands/plan-v1.ts` | **Modified** — Slim to adapter (~15 lines, from 58) |
| `src/commands/init.ts` | **Modified** — Slim to adapter (~15 lines, from 283) |
| `src/commands/worktree.ts` | **Modified** — Slim to adapter (~50 lines, from 291) |
| `test/commands/init-skills.test.ts` | **Modified** — Update import path |

## Size Impact

| Metric | Before | After |
|--------|--------|-------|
| Total lines across command files | ~2,442 | ~2,442 (same — logic moves, doesn't shrink) |
| Framework-coupled lines | ~1,574 | ~365 (adapter files only) |
| Lines to rewrite for commander.js swap | ~2,442 | ~365 + `bin.ts` |
| New utility files | 0 | 3 (`stdin.ts`, `parse-args.ts`, `context.ts`) |

## Execution Order

Phases 1 through 6 are sequential (each handler extraction depends on Phase 1 utilities). Within Phase 5, the three commands are independent and can be done in any order. Phase 7 is the final verification gate.

Critical path: Phase 1 → Phase 2 → ... → Phase 6 → Phase 7.

Total estimated effort: ~1 day.

## Not In Scope

- Replacing citty with commander.js (separate future initiative)
- Adding help text, examples, or rich descriptions (blocked on commander.js)
- Changing the JSON envelope output contract
- Modifying test files beyond the one import path fix
- Extracting `bin.ts` error handling (stays citty-specific until framework swap)
