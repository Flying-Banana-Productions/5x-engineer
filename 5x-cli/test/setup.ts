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
