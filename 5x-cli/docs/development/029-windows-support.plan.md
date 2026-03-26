# Windows 10/11 Support

**Version:** 1.0
**Created:** March 25, 2026
**Status:** Draft

## Overview

The 5x-cli has zero `process.platform` checks today. The codebase is ~90%
cross-platform thanks to consistent use of `node:path` and `node:fs`. The
remaining issues are concentrated in 4 concerns: **shell execution**, **HOME
directory resolution**, **signal handling**, and **test infrastructure**.

The cursor harness — the highest priority target for Windows — is nearly fully
compatible already: it's pure file I/O using `path.join()` and `node:fs`.

## Design Decisions

**`cmd /c` over PowerShell for shell execution.** `cmd /c` starts in ~50ms vs
~300ms for PowerShell. Quality gates and post-worktree hooks are typically
simple commands (`npm test`, `bun install`). Users who need PowerShell can
write `powershell -Command "..."` in their quality gate config.

**Centralize platform branching in a single helper.** Rather than scattering
`process.platform === "win32"` checks throughout the codebase, introduce one
small `src/utils/platform.ts` module that exports `shellArgs()`. All callers
use it; none check the platform themselves.

**Use `os.homedir()` as the canonical home directory source.** Node's
`os.homedir()` already handles `USERPROFILE` on Windows and `HOME` on Unix.
The current code's `process.env.HOME` fallback is redundant at best and broken
on Windows at worst. Remove it.

**Leave graceful-degradation items alone.** `/dev/tty` fallback, `SIGTERM`
handlers, `mode: 0o700` on `mkdirSync` — all degrade safely on Windows
(no crash, no data loss). Fixing them would add complexity for no user-visible
benefit.

## Audit Results

### BLOCKING (crashes or silent wrong behavior on Windows)

| # | Issue | Files | Impact |
|---|-------|-------|--------|
| 1 | `["sh", "-c", cmd]` hardcoded | `subprocess.ts:73`, `quality.ts:245` | All shell commands fail — quality gates, post-worktree hooks |
| 2 | `process.env.HOME` passed as `homeDir` | `harness.ts:54,66,95` | Passes `undefined` on Windows; works by accident via fallback chain but fragile |
| 3 | Permission mode warning reads Unix bits | `run-v1.handler.ts:1306-1315` | Spurious warnings on Windows (stat mode bits differ) |

### GRACEFUL DEGRADATION (works but with reduced functionality)

| # | Issue | Files | Impact |
|---|-------|-------|--------|
| 4 | `/dev/tty` fallback for piped stdin | `src/utils/stdin.ts:35-41` | `existsSync("/dev/tty")` returns false — degrades to no-tty-fallback. Normal TTY prompts work. |
| 5 | `SIGTERM`/`SIGKILL` signal handling | `lock.ts:305-312`, `connection.ts:47-54`, `quality.ts:285,296` | SIGTERM handlers are no-ops on Windows (harmless — `exit` handler is the safety net). `proc.kill("SIGTERM")` maps to `TerminateProcess()` in Bun on Windows. |
| 6 | `mode: 0o700` on `mkdirSync` | 5 files | Silently ignored on Windows — harmless |

### NOT AN ISSUE (already cross-platform)

- **Path construction**: `node:path` (`join`/`resolve`/`relative`) used throughout
- **Git ops**: spawns `git` directly (not via shell) — works with Git for Windows
- **File I/O**: standard `node:fs` APIs
- **Dependencies**: all pure JS/TS (no native modules)
- **`process.kill(pid, 0)`** PID liveness check: works on Windows in Bun
- **`process.stdin.isTTY`**: works on Windows
- **Bun runtime**: supports Windows since v1.0.25+
- **`.5x/` dot-directories**: accessible on Windows (just not hidden in Explorer by default)
- **Backslash handling** in `tui/permissions.ts:90-94`: already normalizes `\\` to `/`

### TEST INFRASTRUCTURE (blocks running tests on Windows)

| # | Issue | Files |
|---|-------|-------|
| 7 | `unset` bash builtin in test script | `package.json:41` |
| 8 | `Bun.spawn(["sleep", "60"])` | `lock.test.ts:110,245,324` |
| 9 | Example script is bash-only | `examples/author-review-loop.sh` (out of scope for this implementation — see Known limitations) |

## Cursor Harness: Detailed Assessment

The cursor harness (`src/harnesses/cursor/`) is **almost entirely Windows-ready**:

- **No shell commands** — pure file installation
- **No process spawning** — no `child_process`, `exec`, or `spawn`
- **Correct path handling** — all paths via `path.join()`
- **YAML escaping handles `\r\n`** — `cursor/loader.ts:46` escapes `\r`
- **Only gap**: `process.env.HOME` in the fallback chain (Issue #2 above)

**Remaining unknown**: Whether Cursor IDE on Windows discovers files from
`%USERPROFILE%\.cursor\{skills,agents}`. The PRD
(`docs/027-cursor-harness-native-workflows.prd.md:95-107`) flags this as
requiring manual verification.

## Implementation

### Phase 1: Cross-platform shell helper

- [x] New file `src/utils/platform.ts` with `shellArgs()` and `userHomeDir()` as specified below.

**New file: `src/utils/platform.ts`**

```typescript
import { homedir } from "node:os";

const isWin = process.platform === "win32";

/** Shell command vector for spawning user-authored shell commands. */
export function shellArgs(command: string): string[] {
  return isWin ? ["cmd", "/c", command] : ["sh", "-c", command];
}

/** Cross-platform home directory — single source of truth. */
export function userHomeDir(): string {
  return homedir();
}
```

### Phase 2: Fix blocking issues

- [x] `src/utils/subprocess.ts` — `shellArgs()` for shell spawn
- [x] `src/gates/quality.ts` — `shellArgs()` for quality gate commands
- [x] `src/commands/harness.ts` — `homedir()` from `node:os` instead of `process.env.HOME`
- [x] `src/harnesses/locations.ts` — home fallback to `homedir()` only (keep `homeDir` for tests)
- [x] `src/commands/run-v1.handler.ts` — guard permission-mode stat on non-Windows
- [x] JSDoc in `harness.handler.ts` / `types.ts` aligned with `homedir()` usage

**`src/utils/subprocess.ts`** — Replace `["sh", "-c", command]` with
`shellArgs(command)` (line 73). Import `shellArgs` from `./platform.js`.

**`src/gates/quality.ts`** — Same replacement (line 245). Import `shellArgs`
from `../utils/platform.js`.

**`src/commands/harness.ts`** — Replace `process.env.HOME` with `homedir()`
from `node:os` at lines 54, 66, 95.

**`src/harnesses/locations.ts`** — Simplify fallback from
`process.env.HOME ?? homedir()` to just `homedir()` at lines 89, 126, 166.
The `homeDir` param still exists for test injection.

**`src/commands/run-v1.handler.ts`** — Guard the permission-mode stat check
with `process.platform !== "win32"` at lines 1306-1315.

### Phase 3: Test infrastructure

**`bunfig.toml` already preloads `./test/setup.ts`.** That file deletes
`GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` before tests run (see
`test/setup.ts`). No duplicate preload is needed; extend documentation only if
implementers need extra clarity on hook-inherited `GIT_*` vs. `cleanGitEnv()`
in tests.

**`package.json`** — Remove the bash-only
`(unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE; …)` wrapper and invoke tests with
`bun test --concurrent --dots` (or equivalent). Rely on the existing preload for
cross-platform `GIT_*` cleanup; do **not** add a second preload.

**`test/integration/lock.test.ts`** — Replace `Bun.spawn(["sleep", "60"])`
with `Bun.spawn(["bun", "-e", "await Bun.sleep(60000)"])` at lines 110, 245,
324.

### Phase 4: No-change items (documented as intentional)

These are explicitly left as-is:

- **`examples/author-review-loop.sh`** — **Out of scope** for this
  implementation; it remains bash-only. Windows users should run it under WSL,
  Git Bash, or wait for a follow-up (e.g. a portable script or documented
  alternative).
- `/dev/tty` fallback — graceful degradation, no crash
- `SIGTERM` handlers — harmless no-ops on Windows, `exit` handler is the real
  cleanup
- `proc.kill("SIGTERM")`/`proc.kill("SIGKILL")` — Bun maps both to
  `TerminateProcess()` on Windows
- `mode: 0o700` on `mkdirSync` — silently ignored on Windows
- `.5x/` hidden directories — work fine, just not visually hidden in Explorer

## Files Changed

| File | Change | Priority |
|---|---|---|
| `src/utils/platform.ts` **(new)** | `shellArgs()` and `userHomeDir()` | P0 |
| `src/utils/subprocess.ts` | Import + use `shellArgs()` | P0 |
| `src/gates/quality.ts` | Import + use `shellArgs()` | P0 |
| `src/commands/harness.ts` | Use `os.homedir()` instead of `process.env.HOME` | P0 |
| `src/harnesses/locations.ts` | Simplify home fallback to `homedir()` | P0 |
| `src/commands/run-v1.handler.ts` | Guard permission-mode warning | P1 |
| `package.json` | Cross-platform test script | P2 |
| `test/integration/lock.test.ts` | Replace `sleep` with Bun-native process | P2 |

**Out of scope (not modified):** `examples/author-review-loop.sh` — remains
bash-only; see Phase 4 and Known limitations.

**Total: 1 new file, 7 modified files. No architectural changes. No new
dependencies.**

## Verification

### Automated (run on current machine)

1. `bun test --concurrent --dots` — all existing tests still pass
2. Grep for remaining `"sh"` in spawn calls — should be zero outside
   `platform.ts`
3. **`process.env.HOME` in `src/`** — either:
   - **Option A:** Update JSDoc in `src/commands/harness.handler.ts` and
     `src/harnesses/types.ts` so they no longer reference `process.env.HOME`
     where the implementation uses `os.homedir()`, then grep `src/` and expect
     matches only where intentionally documented (e.g. `locations.ts` comments); or
   - **Option B:** Run grep restricted to **production code**, excluding
     comments and docs — e.g. `rg 'process\.env\.HOME' src --glob '*.ts'`
     with a filter that omits comment-only lines, or verify by file that only
     allowed call sites remain after the harness changes.

### Manual (requires Windows 10/11 with Bun + Git for Windows)

1. `bun run src/bin.ts --help` — CLI boots
2. `bun run src/bin.ts harness install cursor -s user` — files created under
   `%USERPROFILE%\.cursor\`
3. `bun run src/bin.ts harness install cursor -s project` — files created
   under `.cursor\` in CWD
4. Open Cursor IDE — verify it discovers installed agents/skills from both
   scopes
5. `bun run src/bin.ts harness list` — shows correct install status
6. Quality gate with `echo hello` — runs via `cmd /c`
7. `bun test` — test suite passes
8. Ctrl+C during `5x run watch` — clean exit, lock released

## Known limitations

- **`examples/author-review-loop.sh`** is not ported in this work; it stays
  bash-only. Use WSL, Git Bash, or a future follow-up for Windows-native usage.

## Revision history

| Date | Summary |
|------|---------|
| March 25, 2026 | Review-driven edits: Phase 3 aligned with existing `bunfig.toml` preload (`test/setup.ts` clears `GIT_*`); removed duplicate-preload wording; `package.json` change described as dropping bash `unset` only. Verification: explicit options for `process.env.HOME` (JSDoc in `harness.handler.ts` / `types.ts` vs. grep excluding comments). `examples/author-review-loop.sh` marked out of scope. Audit: `stdin.ts` → `src/utils/stdin.ts`. |
