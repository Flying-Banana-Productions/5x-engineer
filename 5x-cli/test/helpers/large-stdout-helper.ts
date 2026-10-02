/**
 * Helper script for stdout-lossless.test.ts — prints a large line after
 * putting stdout in the state that makes Bun's own `console.log` truncate on
 * a pipe, then exits the way bin.ts error paths do.
 *
 * argv: <bytes> <"lossless" | "raw">
 */
import { installLosslessConsoleLog } from "../../src/utils/stdout.js";

const bytes = Number(process.argv[2]);
if (process.argv[3] === "lossless") installLosslessConsoleLog();

// Reading the terminal width switches a piped stdout to non-blocking mode.
void process.stdout.columns;

console.log("x".repeat(bytes));
console.log("tail");
process.exit(3);
