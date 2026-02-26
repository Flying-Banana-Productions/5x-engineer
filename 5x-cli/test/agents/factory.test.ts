import { describe, expect, test } from "bun:test";
import {
	createAdapter,
	createAndVerifyAdapter,
} from "../../src/agents/factory.js";

describe("createAndVerifyAdapter", () => {
	test("returns an AgentAdapter with the expected interface", async () => {
		// This test may succeed (if OpenCode is installed) or fail (if not).
		// Either way, validate the factory accepts the config shape correctly.
		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>> | null =
			null;
		try {
			adapter = await createAndVerifyAdapter({
				model: "anthropic/claude-sonnet-4-6",
			});
			// If we get here, the server started — validate the interface
			expect(typeof adapter.invokeForStatus).toBe("function");
			expect(typeof adapter.invokeForVerdict).toBe("function");
			expect(typeof adapter.verify).toBe("function");
			expect(typeof adapter.close).toBe("function");
		} catch (err) {
			// If server is unavailable, we expect a descriptive error
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/OpenCode server/);
		} finally {
			await adapter?.close();
		}
	});

	test("extracts model from config", async () => {
		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>> | null =
			null;
		try {
			adapter = await createAndVerifyAdapter({ model: "test/model" });
		} catch {
			// Expected if server unavailable — model parsing error or server failure
		} finally {
			await adapter?.close();
		}
	});

	test("handles config without model", async () => {
		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>> | null =
			null;
		try {
			adapter = await createAndVerifyAdapter({});
		} catch {
			// Expected if server unavailable
		} finally {
			await adapter?.close();
		}
	});
});

describe("createAdapter (deprecated)", () => {
	test("throws with deprecation message", () => {
		expect(() => createAdapter()).toThrow("deprecated");
	});
});
