/**
 * Unit tests for abortable stdin helpers.
 *
 * Serializes tests that mutate module-level stdin state so they stay
 * deterministic under `bun test --concurrent`. SIGINT is injected via a fake
 * host — tests never emit process SIGINT.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
	_resetStdinForTest,
	_setInputStreamForTest,
	_setPipeStreamForTest,
	_setSigintHostForTest,
	ABORTED,
	EOF,
	readAll,
	readLine,
	readStdinPipe,
	SIGINT,
	type StdinSigintHost,
} from "../../../src/utils/stdin.js";

interface FakeSigint {
	host: StdinSigintHost;
	count: () => number;
	emit: () => void;
}

function createFakeSigint(): FakeSigint {
	const listeners: Array<() => void> = [];
	return {
		host: {
			once(_event, listener) {
				listeners.push(listener);
			},
			removeListener(_event, listener) {
				const i = listeners.indexOf(listener);
				if (i >= 0) listeners.splice(i, 1);
			},
		},
		count: () => listeners.length,
		emit() {
			const copy = [...listeners];
			listeners.length = 0;
			for (const listener of copy) listener();
		},
	};
}

function hangingPipe(onCancel: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start() {},
		cancel() {
			onCancel();
		},
	});
}

function textPipe(text: string): ReadableStream<Uint8Array> {
	const encoded = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			if (encoded.byteLength > 0) controller.enqueue(encoded);
			controller.close();
		},
	});
}

/** Serialize access to stdin module state under `--concurrent`. */
let chain = Promise.resolve();

function serial(name: string, fn: () => void | Promise<void>): void {
	test(name, async () => {
		let release!: () => void;
		const prev = chain;
		chain = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			_resetStdinForTest();
			await fn();
		} finally {
			_resetStdinForTest();
			release();
		}
	});
}

describe("readLine abort", () => {
	serial("abort before wait resolves ABORTED", async () => {
		const ac = new AbortController();
		ac.abort();
		expect(await readLine(ac.signal)).toBe(ABORTED);
	});

	serial("abort mid-wait resolves ABORTED and removes listeners", async () => {
		const stream = new PassThrough();
		const sigint = createFakeSigint();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(sigint.host);
		const ac = new AbortController();
		const pending = readLine(ac.signal);
		expect(stream.listenerCount("data")).toBe(1);
		expect(stream.listenerCount("end")).toBe(1);
		expect(sigint.count()).toBe(1);
		ac.abort();
		expect(await pending).toBe(ABORTED);
		expect(stream.listenerCount("data")).toBe(0);
		expect(stream.listenerCount("end")).toBe(0);
		expect(sigint.count()).toBe(0);
	});

	serial("no signal returns a line", async () => {
		const stream = new PassThrough();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(createFakeSigint().host);
		const pending = readLine();
		stream.write("hello\n");
		expect(await pending).toBe("hello");
	});

	serial("no signal returns EOF on stream end", async () => {
		const stream = new PassThrough();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(createFakeSigint().host);
		const pending = readLine();
		stream.end();
		expect(await pending).toBe(EOF);
	});
});

describe("readAll abort and SIGINT", () => {
	serial("abort before wait resolves ABORTED", async () => {
		const ac = new AbortController();
		ac.abort();
		expect(await readAll(ac.signal)).toBe(ABORTED);
	});

	serial("abort mid-wait resolves ABORTED and removes listeners", async () => {
		const stream = new PassThrough();
		const sigint = createFakeSigint();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(sigint.host);
		const ac = new AbortController();
		const pending = readAll(ac.signal);
		expect(stream.listenerCount("data")).toBe(1);
		expect(stream.listenerCount("end")).toBe(1);
		expect(sigint.count()).toBe(1);
		ac.abort();
		expect(await pending).toBe(ABORTED);
		expect(stream.listenerCount("data")).toBe(0);
		expect(stream.listenerCount("end")).toBe(0);
		expect(sigint.count()).toBe(0);
	});

	serial("SIGINT resolves SIGINT sentinel, not partial chunks", async () => {
		const stream = new PassThrough();
		const sigint = createFakeSigint();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(sigint.host);
		const pending = readAll();
		stream.write("partial text");
		sigint.emit();
		expect(await pending).toBe(SIGINT);
		expect(stream.listenerCount("data")).toBe(0);
		expect(stream.listenerCount("end")).toBe(0);
		expect(sigint.count()).toBe(0);
	});

	serial(
		"stream-end with empty text is collected string, not EOF",
		async () => {
			const stream = new PassThrough();
			_setInputStreamForTest(stream);
			_setSigintHostForTest(createFakeSigint().host);
			const pending = readAll();
			stream.end();
			const result = await pending;
			expect(result).toBe("");
			expect(result).not.toBe(EOF);
			expect(stream.listenerCount("data")).toBe(0);
			expect(stream.listenerCount("end")).toBe(0);
		},
	);

	serial("stream-end with text is collected string, not EOF", async () => {
		const stream = new PassThrough();
		_setInputStreamForTest(stream);
		_setSigintHostForTest(createFakeSigint().host);
		const pending = readAll();
		stream.write("hello");
		stream.write(" world");
		stream.end();
		const result = await pending;
		expect(result).toBe("hello world");
		expect(result).not.toBe(EOF);
		expect(stream.listenerCount("data")).toBe(0);
		expect(stream.listenerCount("end")).toBe(0);
	});
});

describe("readStdinPipe abort", () => {
	serial("abort before wait resolves ABORTED", async () => {
		const ac = new AbortController();
		ac.abort();
		expect(await readStdinPipe(ac.signal)).toBe(ABORTED);
	});

	serial("abort mid-read resolves ABORTED and cancels the reader", async () => {
		let cancelled = false;
		_setPipeStreamForTest(() =>
			hangingPipe(() => {
				cancelled = true;
			}),
		);
		const ac = new AbortController();
		const pending = readStdinPipe(ac.signal);
		await Promise.resolve();
		ac.abort();
		expect(await pending).toBe(ABORTED);
		expect(cancelled).toBe(true);
	});

	serial("no-signal path returns piped text", async () => {
		_setPipeStreamForTest(() => textPipe("piped text"));
		expect(await readStdinPipe()).toBe("piped text");
	});
});
