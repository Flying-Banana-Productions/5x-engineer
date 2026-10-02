import { describe, expect, test } from "bun:test";
import { writeAllSync } from "../../../src/utils/stdout.js";

function errno(code: string): Error {
	return Object.assign(new Error(code), { code });
}

describe("writeAllSync", () => {
	test("loops over partial writes and retries after EAGAIN", () => {
		const chunks: string[] = [];
		let calls = 0;
		let waits = 0;
		writeAllSync(1, "héllo wörld\n", {
			write: (_fd, bytes, offset, length) => {
				calls++;
				if (calls % 2 === 0) throw errno("EAGAIN");
				const n = Math.min(3, length);
				chunks.push(
					Buffer.from(bytes.subarray(offset, offset + n)).toString("latin1"),
				);
				return n;
			},
			wait: () => {
				waits++;
			},
		});
		expect(Buffer.from(chunks.join(""), "latin1").toString("utf8")).toBe(
			"héllo wörld\n",
		);
		expect(waits).toBeGreaterThan(0);
	});

	test("stops quietly when the reader has gone away", () => {
		let calls = 0;
		writeAllSync(1, "abcdef", {
			write: (_fd, _bytes, _offset, _length) => {
				calls++;
				if (calls > 1) throw errno("EPIPE");
				return 2;
			},
		});
		expect(calls).toBe(2);
	});

	test("rethrows unexpected write errors", () => {
		expect(() =>
			writeAllSync(1, "abc", {
				write: () => {
					throw errno("EIO");
				},
			}),
		).toThrow("EIO");
	});
});
