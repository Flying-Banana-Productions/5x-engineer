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
	 * We cannot actually install an external package in unit tests, but we
	 * can verify the contract: when the dynamic import succeeds (external
	 * path), the result should have source: "external". When it fails with
	 * module-not-found and the name matches a bundled harness, it should
	 * have source: "bundled".
	 *
	 * This test verifies the bundled fallback path by loading a known
	 * bundled harness name that has no external override installed.
	 */
	test("bundled fallback produces source: bundled (no external override)", async () => {
		// "opencode" is bundled and no @5x-ai/harness-opencode package exists
		const loaded = await loadHarnessPlugin("opencode");
		expect(loaded.source).toBe("bundled");
	});

	test("unknown harness name throws HarnessNotFoundError", async () => {
		await expect(loadHarnessPlugin("definitely-not-a-harness")).rejects.toThrow(
			"not found",
		);
	});
});
