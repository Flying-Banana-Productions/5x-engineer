/**
 * Global test preload — suppress console output during tests.
 *
 * Production code uses bare console.log/console.warn for orchestrator
 * status messages. These are noisy in test output. This preload replaces
 * them with no-ops.
 *
 * Tests that need to assert on console output can monkey-patch
 * console.warn/console.log as before — they capture into their own
 * arrays and restore afterward.
 */

console.log = () => {};
console.warn = () => {};
