/**
 * Factory verification for the bundled OpenCode provider, through the
 * `OpenCodeFactoryDeps` seam. No network I/O and no subprocesses.
 */

import { describe, expect, test } from "bun:test";
import type { FiveXConfig } from "../../../src/config.js";
import {
	createProvider,
	type OpenCodeFactoryDeps,
} from "../../../src/providers/factory.js";
import type { OpenCodeProvider } from "../../../src/providers/opencode.js";

interface FakeProvider {
	calls: string[];
	verify(): Promise<void>;
	close(): Promise<void>;
	startSession(): Promise<never>;
	resumeSession(): Promise<never>;
}

function fakeProvider(verifyError?: Error): FakeProvider {
	const calls: string[] = [];
	return {
		calls,
		async verify() {
			calls.push("verify");
			if (verifyError) throw verifyError;
		},
		async close() {
			calls.push("close");
		},
		async startSession() {
			throw new Error("not used");
		},
		async resumeSession() {
			throw new Error("not used");
		},
	};
}

function fakeDeps(provider: FakeProvider): {
	deps: OpenCodeFactoryDeps;
	created: Array<{ mode: string; url?: string; model?: string }>;
} {
	const created: Array<{ mode: string; url?: string; model?: string }> = [];
	return {
		created,
		deps: {
			async createManaged(opts) {
				created.push({ mode: "managed", model: opts.model });
				return provider as unknown as OpenCodeProvider;
			},
			createExternal(url, opts) {
				created.push({ mode: "external", url, model: opts.model });
				return provider as unknown as OpenCodeProvider;
			},
		},
	};
}

function config(url?: string): FiveXConfig {
	return {
		author: { provider: "opencode", model: "opencode/test-model" },
		reviewer: { provider: "opencode" },
		opencode: url ? { url } : {},
	} as unknown as FiveXConfig;
}

describe("createProvider — bundled opencode verification", () => {
	test("external healthy: verify() runs and the provider is returned", async () => {
		const provider = fakeProvider();
		const { deps, created } = fakeDeps(provider);
		const result = await createProvider(
			"author",
			config("http://127.0.0.1:4096"),
			{ openCode: deps },
		);
		expect(result).toBe(provider as unknown as typeof result);
		expect(created).toEqual([
			{
				mode: "external",
				url: "http://127.0.0.1:4096",
				model: "opencode/test-model",
			},
		]);
		expect(provider.calls).toEqual(["verify"]);
	});

	test("external unauthorized: the password error propagates and the provider is closed", async () => {
		const provider = fakeProvider(
			new Error(
				"the OpenCode server requires a password — set OPENCODE_PASSWORD",
			),
		);
		const { deps } = fakeDeps(provider);
		await expect(
			createProvider("author", config("http://127.0.0.1:4096"), {
				openCode: deps,
			}),
		).rejects.toThrow("set OPENCODE_PASSWORD");
		expect(provider.calls).toEqual(["verify", "close"]);
	});

	test("external verification failure (1.x or old 2.x): error propagates and provider is closed", async () => {
		for (const message of [
			"5x 2.x requires OpenCode ≥ 2.4.2 (found 1.x) — run `opencode upgrade --major`",
			"5x 2.x requires OpenCode ≥ 2.4.2 (found 2.3.2) — run `opencode upgrade`",
		]) {
			const provider = fakeProvider(new Error(message));
			const { deps } = fakeDeps(provider);
			await expect(
				createProvider("reviewer", config("http://127.0.0.1:4096"), {
					openCode: deps,
				}),
			).rejects.toThrow(message);
			expect(provider.calls).toEqual(["verify", "close"]);
		}
	});

	test("managed verification failure: the provider is closed", async () => {
		const provider = fakeProvider(new Error("found 1.x"));
		const { deps, created } = fakeDeps(provider);
		await expect(
			createProvider("author", config(), { openCode: deps }),
		).rejects.toThrow("found 1.x");
		expect(created[0]?.mode).toBe("managed");
		expect(provider.calls).toEqual(["verify", "close"]);
	});

	test("opencode.url selects createExternal; its absence selects createManaged", async () => {
		const external = fakeDeps(fakeProvider());
		await createProvider("author", config("http://h:1"), {
			openCode: external.deps,
		});
		expect(external.created.map((c) => c.mode)).toEqual(["external"]);

		const managed = fakeDeps(fakeProvider());
		await createProvider("reviewer", config(), { openCode: managed.deps });
		expect(managed.created).toEqual([{ mode: "managed", model: undefined }]);
	});
});
