import { describe, expect, test } from "bun:test";
import cursorAgentPlugin, {
	parseCursorAgentPluginConfig,
} from "../../../../packages/provider-cursor-agent/src/index.js";

describe("parseCursorAgentPluginConfig", () => {
	test("returns safe defaults on missing / invalid input", () => {
		expect(parseCursorAgentPluginConfig(undefined)).toEqual({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		expect(parseCursorAgentPluginConfig(null as unknown as undefined)).toEqual({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
	});

	test("defaults force=true and trust=true", () => {
		expect(parseCursorAgentPluginConfig({})).toEqual({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
	});

	test("force=false override disables force default", () => {
		expect(parseCursorAgentPluginConfig({ force: false }).force).toBe(false);
	});

	test("trust=false override disables trust default", () => {
		expect(parseCursorAgentPluginConfig({ trust: false }).trust).toBe(false);
	});

	test("preserves valid typed fields", () => {
		const cfg = parseCursorAgentPluginConfig({
			agentBinary: "/usr/bin/agent",
			force: false,
			trust: false,
			sandbox: "enabled",
			approveMcps: true,
			pluginDir: [".cursor/plugins/a", ".cursor/plugins/b"],
			apiKey: "key-123",
			authToken: "token-456",
		});
		expect(cfg).toEqual({
			agentBinary: "/usr/bin/agent",
			force: false,
			trust: false,
			sandbox: "enabled",
			approveMcps: true,
			pluginDir: [".cursor/plugins/a", ".cursor/plugins/b"],
			apiKey: "key-123",
			authToken: "token-456",
		});
	});

	test("ignores invalid optional fields", () => {
		const cfg = parseCursorAgentPluginConfig({
			sandbox: "maybe",
			approveMcps: "yes",
			pluginDir: ["ok", "", 42, null],
			apiKey: "",
			authToken: 123,
			force: "no",
			trust: 0,
			agentBinary: 99,
		});
		expect(cfg).toEqual({
			agentBinary: "agent",
			force: true,
			trust: true,
			pluginDir: ["ok"],
		});
	});

	test("drops empty pluginDir arrays", () => {
		expect(
			parseCursorAgentPluginConfig({ pluginDir: [] }).pluginDir,
		).toBeUndefined();
		expect(
			parseCursorAgentPluginConfig({ pluginDir: "nope" as unknown as string[] })
				.pluginDir,
		).toBeUndefined();
	});
});

describe("cursorAgentPlugin", () => {
	test("exports provider name cursor-agent", () => {
		expect(cursorAgentPlugin.name).toBe("cursor-agent");
	});
});
