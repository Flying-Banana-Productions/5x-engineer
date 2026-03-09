/**
 * Global test preload — suppress console output during tests.
 *
 * Production code uses bare console.log/console.warn for orchestrator
 * status messages. These are noisy in test output. This preload replaces
 * them with no-ops.
 *
 * ## Warning assertions under --concurrent
 *
 * Tests that need to assert on warnings should NOT monkey-patch
 * console.warn — this mutates a global and is racy under `bun test
 * --concurrent`. Instead, use dependency-injected warning sinks:
 *
 * - **ClaudeCodeAdapter tests:** use `captureWarnings` in `createMock()`
 *   options. The adapter's `protected warn()` method routes warnings
 *   through the injected sink without touching console.warn.
 *
 * - **parseJsonOutput tests:** pass a capturing function as the `warn`
 *   parameter directly.
 *
 * - **Other modules:** prefer injectable warn/log parameters or class
 *   method overrides over global console mutation. If global mutation
 *   is unavoidable, keep the try/finally window as short as possible
 *   and consider marking the test file as serial if flakes appear.
 */

console.log = () => {};
console.warn = () => {};

// ---------------------------------------------------------------------------
// Sanitize git environment variables
// ---------------------------------------------------------------------------
// When tests run inside a git hook (e.g. pre-push from a worktree), git
// sets GIT_DIR which leaks into Bun.spawnSync/Bun.spawn calls. This
// causes git commands in tests to operate on the real repo's index
// instead of temp dirs, corrupting the working tree.
//
// NOTE: `delete process.env.X` in Bun does NOT call unsetenv() at the
// C level — child processes still inherit the original value. The delete
// below helps in-process code that reads process.env directly, but ALL
// Bun.spawnSync / Bun.spawn calls must also pass `env: cleanGitEnv()`
// from test/helpers/clean-env.ts. See that file for details.
// ---------------------------------------------------------------------------
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
