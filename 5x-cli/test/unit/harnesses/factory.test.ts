/**
 * Tests for harness factory — LoadedHarnessPlugin source tracking.
 *
 * Phase 2 (017-harness-and-skills-uninstall).
 */

import { describe, expect, test } from "bun:test";
import {
	type LoadedHarnessPlugin,
	loadHarnessPlugin,
} from "../../../src/harnesses/factory.js";
import type { HarnessPlugin } from "../../../src/harnesses/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake HarnessPlugin for testing external-override detection.
 * Only the fields checked by `isValidPlugin()` need to be present.
 */
function makeFakePlugin(overrides?: Partial<HarnessPlugin>): HarnessPlugin {
	return {
		name: overrides?.name ?? "opencode",
		description: overrides?.description ?? "fake external plugin",
		supportedScopes: overrides?.supportedScopes ?? ["project", "user"],
		locations: overrides?.locations ?? {
			resolve: () => ({
				skillsDir: "/tmp/skills",
				agentsDir: "/tmp/agents",
			}),
		},
		describe:
			overrides?.describe ?? (() => ({ skillNames: [], agentNames: [] })),
		install: (overrides?.install ??
			(async () => ({
				skills: { written: [], skipped: [] },
				agents: { written: [], skipped: [] },
			}))) as HarnessPlugin["install"],
		uninstall: (overrides?.uninstall ??
			(async () => ({
				skills: { removed: [], notFound: [] },
				agents: { removed: [], notFound: [] },
			}))) as HarnessPlugin["uninstall"],
	};
}

// ---------------------------------------------------------------------------
// Bundled harness loading
// ---------------------------------------------------------------------------

describe("loadHarnessPlugin — source tracking", () => {
	test("loading bundled 'opencode' returns source: bundled", async () => {
		const loaded: LoadedHarnessPlugin = await loadHarnessPlugin("opencode");

		expect(loaded.source).toBe("bundled");
		expect(loaded.plugin).toBeDefined();
		expect(loaded.plugin.name).toBe("opencode");
	});

	test("loaded plugin has all required members", async () => {
		const { plugin } = await loadHarnessPlugin("opencode");

		expect(typeof plugin.install).toBe("function");
		expect(typeof plugin.uninstall).toBe("function");
		expect(typeof plugin.describe).toBe("function");
		expect(plugin.locations).toBeDefined();
		expect(typeof plugin.locations.resolve).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// External override detection
// ---------------------------------------------------------------------------

describe("loadHarnessPlugin — external override detection", () => {
	/**
	 * Critical regression test: an external package that overrides a bundled
	 * name must be labeled source: "external", not "bundled".
	 *
	 * Uses the injected importFn to simulate a successful dynamic import
	 * for @5x-ai/harness-opencode — an external package that overrides
	 * the bundled "opencode" harness. The result must be source: "external".
	 */
	test("external override of bundled name returns source: external", async () => {
		const fakePlugin = makeFakePlugin({ name: "opencode" });

		// Simulate a successful external import for @5x-ai/harness-opencode
		const importFn = async (_specifier: string) => ({
			default: fakePlugin,
		});

		const loaded = await loadHarnessPlugin("opencode", importFn);

		expect(loaded.source).toBe("external");
		expect(loaded.plugin).toBe(fakePlugin);
		expect(loaded.plugin.name).toBe("opencode");
	});

	test("external override for non-bundled name returns source: external", async () => {
		const fakePlugin = makeFakePlugin({ name: "cursor" });

		const importFn = async (_specifier: string) => ({
			default: fakePlugin,
		});

		const loaded = await loadHarnessPlugin("cursor", importFn);

		expect(loaded.source).toBe("external");
		expect(loaded.plugin.name).toBe("cursor");
	});

	test("bundled fallback produces source: bundled (no external override)", async () => {
		// "opencode" is bundled and no @5x-ai/harness-opencode package exists
		const loaded = await loadHarnessPlugin("opencode");
		expect(loaded.source).toBe("bundled");
	});

	test("external package with invalid plugin shape throws InvalidHarnessError", async () => {
		// Return a module whose default export is not a valid plugin
		const importFn = async (_specifier: string) => ({
			default: { name: "bad" }, // missing required fields
		});

		await expect(loadHarnessPlugin("opencode", importFn)).rejects.toThrow(
			"does not export a valid HarnessPlugin",
		);
	});

	test("unknown harness name throws HarnessNotFoundError", async () => {
		await expect(loadHarnessPlugin("definitely-not-a-harness")).rejects.toThrow(
			"not found",
		);
	});
});
