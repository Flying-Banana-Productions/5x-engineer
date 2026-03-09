/**
 * Helper script for pipe.test.ts — reads stdin via readUpstreamEnvelope
 * and prints the result as JSON.
 */
import { readUpstreamEnvelope } from "../../src/pipe.js";

try {
	const result = await readUpstreamEnvelope();
	console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
	console.log(
		JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}
