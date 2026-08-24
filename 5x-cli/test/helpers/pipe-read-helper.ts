/**
 * Helper script for pipe.test.ts — reads stdin via readUpstreamEnvelope
 * and prints the result as JSON. Warnings from the timeout path go to
 * stderr (default sink) and are also listed in `stderrCaptured`.
 */
import { readUpstreamEnvelope } from "../../src/pipe.js";

const stderrCaptured: string[] = [];

try {
	const result = await readUpstreamEnvelope((msg) => {
		stderrCaptured.push(msg);
		console.error(msg);
	});
	console.log(JSON.stringify({ ok: true, result, stderrCaptured }));
} catch (err) {
	console.log(
		JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			stderrCaptured,
		}),
	);
}
