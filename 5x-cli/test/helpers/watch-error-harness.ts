/**
 * Test harness for verifying non-zero exit on watch streaming errors.
 *
 * Usage:
 *   bun run test/helpers/watch-error-harness.ts <projectRoot> <runId>
 *
 * Sets up runV1Watch, patches stdout.write to throw mid-stream,
 * and lets the handler's catch block set process.exitCode.
 */

import { runV1Watch } from "../../src/commands/run-v1.handler.js";

const projectRoot = process.argv[2];
const runId = process.argv[3];

if (!projectRoot || !runId) {
	process.stderr.write("Usage: watch-error-harness.ts <projectRoot> <runId>\n");
	process.exit(2);
}

// Patch stdout.write to throw after the first successful call,
// simulating a broken pipe or other stdout failure mid-stream.
let callCount = 0;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
	callCount++;
	if (callCount > 1) {
		throw new Error("simulated stdout write failure");
	}
	return originalWrite(...args);
}) as typeof process.stdout.write;

try {
	await runV1Watch({
		run: runId,
		workdir: projectRoot,
	});
} catch {
	// runV1Watch should catch streaming errors internally,
	// but if something else throws (e.g., CliError), let it propagate.
}
