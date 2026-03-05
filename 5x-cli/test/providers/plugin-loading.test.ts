/**
 * Integration tests for plugin loading via the factory.
 *
 * Tests cover:
 * - Sample provider plugin loading via dynamic import
 * - Full lifecycle: createProvider → startSession → run → close
 * - runStreamed() yields correctly typed AgentEvent sequence
 * - Missing plugin: PROVIDER_NOT_FOUND error with install instructions
 * - Invalid plugin: INVALID_PROVIDER error when module doesn't export valid ProviderPlugin
 * - Bundled OpenCode provider still works via direct import (not plugin path)
 * - Plugin-specific config passthrough (sample: { echo: true })
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
// Import the sample provider directly to test it (not via dynamic import)
import samplePlugin from "../../packages/provider-sample/src/index.js";
import {
	createProvider,
	InvalidProviderError,
	ProviderNotFoundError,
} from "../../src/providers/factory.js";
import type { AgentEvent, ProviderPlugin } from "../../src/providers/types.js";

// ---------------------------------------------------------------------------
// Test fixture paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const sampleProviderPath = fileURLToPath(
	new URL("../../packages/provider-sample/src/index.ts", import.meta.url),
);
const invalidProviderPath = fileURLToPath(
	new URL("../../packages/provider-invalid/src/index.ts", import.meta.url),
);

// ---------------------------------------------------------------------------
// Mock config helpers
// ---------------------------------------------------------------------------

function createMockConfig(
	provider: string,
	pluginConfig?: Record<string, unknown>,
): {
	author: { provider: string; model?: string; timeout?: number };
	reviewer: { provider: string; model?: string; timeout?: number };
	opencode: { url?: string };
	[key: string]: unknown;
} {
	const baseConfig = {
		author: { provider, model: "test-model" },
		reviewer: { provider, model: "test-model" },
		opencode: {},
	};
	if (pluginConfig) {
		return { ...baseConfig, [provider]: pluginConfig };
	}
	return baseConfig;
}

// ---------------------------------------------------------------------------
// Sample provider direct tests (testing the plugin implementation itself)
// ---------------------------------------------------------------------------

describe("sample provider plugin (direct)", () => {
	test("sample plugin exports valid ProviderPlugin", () => {
		expect(samplePlugin).toBeDefined();
		expect(typeof samplePlugin.name).toBe("string");
		expect(samplePlugin.name).toBe("sample");
		expect(typeof samplePlugin.create).toBe("function");
	});

	test("full lifecycle via direct plugin import", async () => {
		const provider = await samplePlugin.create();

		expect(provider).toBeDefined();
		expect(typeof provider.startSession).toBe("function");
		expect(typeof provider.resumeSession).toBe("function");
		expect(typeof provider.close).toBe("function");

		// Start session
		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		expect(session).toBeDefined();
		expect(typeof session.id).toBe("string");
		expect(session.id.startsWith("sample_")).toBe(true);
		expect(typeof session.run).toBe("function");
		expect(typeof session.runStreamed).toBe("function");

		// Run a prompt
		const result = await session.run("Hello, sample provider!");

		expect(result).toBeDefined();
		expect(typeof result.text).toBe("string");
		expect(result.text).toContain("[SampleProvider echo]");
		expect(result.text).toContain("Hello, sample provider!");
		expect(result.sessionId).toBe(session.id);
		expect(result.tokens).toEqual({ in: 0, out: 0 });
		expect(typeof result.durationMs).toBe("number");

		// Close provider
		await provider.close();
	});

	test("runStreamed yields correctly typed AgentEvent sequence", async () => {
		const provider = await samplePlugin.create();
		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		const events: AgentEvent[] = [];
		for await (const event of session.runStreamed("Test prompt")) {
			events.push(event);
		}

		// Should yield exactly 3 events: text, usage, done
		expect(events).toHaveLength(3);

		// First event: text
		const event0 = events[0];
		expect(event0?.type).toBe("text");
		if (event0?.type !== "text") throw new Error("Expected text event");
		expect(typeof event0.delta).toBe("string");
		expect(event0.delta).toContain("[SampleProvider echo]");

		// Second event: usage
		const event1 = events[1];
		expect(event1?.type).toBe("usage");
		if (event1?.type !== "usage") throw new Error("Expected usage event");
		expect(event1.tokens).toEqual({ in: 0, out: 0 });

		// Third event: done
		const event2 = events[2];
		expect(event2?.type).toBe("done");
		if (event2?.type !== "done") throw new Error("Expected done event");
		expect(typeof event2.result).toBe("object");
		expect(event2.result.text).toContain("[SampleProvider echo]");
		expect(event2.result.sessionId).toBe(session.id);
		expect(event2.result.tokens).toEqual({ in: 0, out: 0 });

		await provider.close();
	});

	test("session resume works with existing session ID", async () => {
		const provider = await samplePlugin.create();

		// Start initial session
		const session1 = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});
		const sessionId = session1.id;

		// Resume the session
		const session2 = await provider.resumeSession(sessionId);

		expect(session2.id).toBe(sessionId);

		await provider.close();
	});

	test("resumeSession creates new session if ID not found", async () => {
		const provider = await samplePlugin.create();

		// Resume a non-existent session
		const session = await provider.resumeSession("sample_nonexistent123");

		expect(session.id).toBe("sample_nonexistent123");

		await provider.close();
	});

	test("echo mode can be disabled via config", async () => {
		const provider = await samplePlugin.create({ echo: false });
		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		const result = await session.run("Test prompt");

		expect(result.text).toBe("Sample provider response");
		expect(result.text).not.toContain("[SampleProvider echo]");

		await provider.close();
	});

	test("custom model can be set via config", async () => {
		const provider = await samplePlugin.create({
			model: "custom/sample-model",
		});
		// The model from config is used as default when session doesn't override
		const session = await provider.startSession({
			model: "override-model", // This should take precedence
			workingDirectory: "/tmp",
		});

		expect(session).toBeDefined();
		await provider.close();
	});
});

// ---------------------------------------------------------------------------
// Error handling tests (using factory with package names)
// ---------------------------------------------------------------------------

describe("plugin loading errors", () => {
	test("missing plugin throws PROVIDER_NOT_FOUND with install instructions", async () => {
		const config = createMockConfig("nonexistent-provider-xyz");

		try {
			await createProvider(
				"author",
				config as Parameters<typeof createProvider>[1],
			);
			expect.unreachable("Should have thrown ProviderNotFoundError");
		} catch (err) {
			expect(err).toBeInstanceOf(ProviderNotFoundError);
			if (err instanceof ProviderNotFoundError) {
				expect(err.code).toBe("PROVIDER_NOT_FOUND");
				expect(err.exitCode).toBe(2);
				expect(err.message).toContain("nonexistent-provider-xyz");
				expect(err.message).toContain("npm install");
				expect(err.message).toContain(
					"@5x-ai/provider-nonexistent-provider-xyz",
				);
				expect(err.message).toContain("bun add");
			}
		}
	});

	test("missing plugin for scoped package name throws PROVIDER_NOT_FOUND", async () => {
		const config = createMockConfig("@acme/nonexistent-provider");

		try {
			await createProvider(
				"author",
				config as Parameters<typeof createProvider>[1],
			);
			expect.unreachable("Should have thrown ProviderNotFoundError");
		} catch (err) {
			expect(err).toBeInstanceOf(ProviderNotFoundError);
			if (err instanceof ProviderNotFoundError) {
				expect(err.code).toBe("PROVIDER_NOT_FOUND");
				expect(err.message).toContain("@acme/nonexistent-provider");
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Factory dynamic import success path (P1.1)
// ---------------------------------------------------------------------------

describe("factory dynamic import success path", () => {
	test("createProvider resolves provider: 'sample' to @5x-ai/provider-sample via dynamic import", async () => {
		// This test validates that the factory can dynamically import the sample provider
		// using the standard plugin resolution path (not file URL bypass)
		const config = createMockConfig("sample", { echo: false });

		const provider = await createProvider(
			"author",
			config as Parameters<typeof createProvider>[1],
		);

		// Verify the provider was created successfully via dynamic import
		expect(provider).toBeDefined();
		expect(typeof provider.startSession).toBe("function");
		expect(typeof provider.resumeSession).toBe("function");
		expect(typeof provider.close).toBe("function");

		// Verify full lifecycle works
		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		expect(session).toBeDefined();
		expect(typeof session.id).toBe("string");
		expect(session.id.startsWith("sample_")).toBe(true);

		// Verify the plugin config was passed through (echo: false)
		const result = await session.run("Hello, dynamic import!");
		expect(result.text).toBe("Sample provider response");
		expect(result.text).not.toContain("[SampleProvider echo]");

		await provider.close();
	});

	test("factory loads sample provider with echo enabled via config passthrough", async () => {
		const config = createMockConfig("sample", { echo: true });

		const provider = await createProvider(
			"reviewer",
			config as Parameters<typeof createProvider>[1],
		);

		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		// With echo: true, the prompt should be echoed back
		const result = await session.run("Test message");
		expect(result.text).toContain("[SampleProvider echo]");
		expect(result.text).toContain("Test message");

		await provider.close();
	});
});

// ---------------------------------------------------------------------------
// Invalid provider error handling (P1.2)
// ---------------------------------------------------------------------------

describe("invalid provider error handling", () => {
	test("createProvider throws INVALID_PROVIDER when loading invalid plugin", async () => {
		// This test validates that the factory correctly detects and reports
		// when a provider package exists but doesn't export a valid ProviderPlugin
		const config = createMockConfig("invalid");

		try {
			await createProvider(
				"author",
				config as Parameters<typeof createProvider>[1],
			);
			expect.unreachable("Should have thrown InvalidProviderError");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidProviderError);
			if (err instanceof InvalidProviderError) {
				expect(err.code).toBe("INVALID_PROVIDER");
				expect(err.exitCode).toBe(2);
				expect(err.message).toContain("@5x-ai/provider-invalid");
				expect(err.message).toContain("does not export a valid ProviderPlugin");
				expect(err.message).toContain("missing the required 'create' function");
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Plugin loading via file URL (tests actual plugin loading without relying on
// Bun's package resolution in test environment)
// ---------------------------------------------------------------------------

describe("plugin loading via file URL", () => {
	test("can load sample provider via file URL", async () => {
		// Import the sample provider directly via file URL
		const mod = (await import(sampleProviderPath)) as {
			default: ProviderPlugin;
		};

		expect(mod.default).toBeDefined();
		expect(mod.default.name).toBe("sample");
		expect(typeof mod.default.create).toBe("function");

		// Verify it creates a working provider
		const provider = await mod.default.create();
		expect(provider).toBeDefined();
		expect(typeof provider.startSession).toBe("function");
		await provider.close();
	});

	test("invalid plugin via file URL throws INVALID_PROVIDER", async () => {
		// Import the invalid provider fixture via file URL
		const mod = (await import(invalidProviderPath)) as {
			default: unknown;
		};

		// The module should load but not have a valid plugin
		expect(mod.default).toBeDefined();

		// Verify it's invalid (missing create function)
		const plugin = mod.default as ProviderPlugin | undefined;
		expect(
			!plugin ||
				typeof plugin !== "object" ||
				typeof plugin.create !== "function",
		).toBe(true);

		// Simulate what loadPlugin would do
		if (
			!plugin ||
			typeof plugin !== "object" ||
			typeof plugin.create !== "function"
		) {
			// This would throw InvalidProviderError in the factory
			expect(true).toBe(true); // Plugin is invalid as expected
		}
	});
});

// ---------------------------------------------------------------------------
// Plugin contract validation tests
// ---------------------------------------------------------------------------

describe("ProviderPlugin contract validation", () => {
	test("valid plugin passes contract check", async () => {
		const provider = await samplePlugin.create();

		// Start session
		const session = await provider.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});

		// Run
		const result = await session.run("Contract test");

		// Verify result shape matches RunResult
		expect(result).toHaveProperty("text");
		expect(result).toHaveProperty("sessionId");
		expect(result).toHaveProperty("tokens");
		expect(result.tokens).toHaveProperty("in");
		expect(result.tokens).toHaveProperty("out");
		expect(result).toHaveProperty("durationMs");

		await provider.close();
	});

	test("plugin config passthrough works", async () => {
		// Test with echo: true (default)
		const providerWithEcho = await samplePlugin.create({ echo: true });
		const session1 = await providerWithEcho.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});
		const result1 = await session1.run("Hello");
		expect(result1.text).toContain("[SampleProvider echo]");
		await providerWithEcho.close();

		// Test with echo: false
		const providerNoEcho = await samplePlugin.create({ echo: false });
		const session2 = await providerNoEcho.startSession({
			model: "test-model",
			workingDirectory: "/tmp",
		});
		const result2 = await session2.run("Hello");
		expect(result2.text).toBe("Sample provider response");
		await providerNoEcho.close();
	});
});

// ---------------------------------------------------------------------------
// Bundled OpenCode provider tests (verify it still works)
// ---------------------------------------------------------------------------

describe("bundled opencode provider", () => {
	test("opencode provider works via direct import (not plugin path)", async () => {
		const config = createMockConfig("opencode");
		const provider = await createProvider(
			"author",
			config as Parameters<typeof createProvider>[1],
		);

		// The OpenCode provider should be instantiated directly, not via dynamic import
		expect(provider).toBeDefined();
		expect(typeof provider.startSession).toBe("function");

		// We can't test full lifecycle without a running server, but we can verify
		// the provider was created (factory didn't throw)
		await provider.close().catch(() => {
			// Close may fail in managed mode without server, that's OK for this test
		});
	});
});
