import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyModelOverrides,
	FiveXConfigSchema,
	loadConfig,
} from "../src/config.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-config-v1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("config v1 extensions", () => {
	// -----------------------------------------------------------------------
	// New fields parse correctly
	// -----------------------------------------------------------------------

	test("provider defaults to 'opencode' in AgentConfig", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.author.provider).toBe("opencode");
			expect(result.data.reviewer.provider).toBe("opencode");
		}
	});

	test("provider accepts arbitrary string (plugin name)", () => {
		const result = FiveXConfigSchema.safeParse({
			author: { provider: "codex" },
			reviewer: { provider: "@acme/provider-foo" },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.author.provider).toBe("codex");
			expect(result.data.reviewer.provider).toBe("@acme/provider-foo");
		}
	});

	test("opencode config defaults to empty object", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.opencode).toEqual({});
			expect(result.data.opencode.url).toBeUndefined();
		}
	});

	test("opencode.url accepts valid URL", () => {
		const result = FiveXConfigSchema.safeParse({
			opencode: { url: "http://localhost:3000" },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.opencode.url).toBe("http://localhost:3000");
		}
	});

	test("opencode.url rejects invalid URL", () => {
		const result = FiveXConfigSchema.safeParse({
			opencode: { url: "not-a-url" },
		});
		expect(result.success).toBe(false);
	});

	test("maxStepsPerRun defaults to 50", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.maxStepsPerRun).toBe(50);
		}
	});

	test("maxStepsPerRun accepts custom value", () => {
		const result = FiveXConfigSchema.safeParse({ maxStepsPerRun: 100 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.maxStepsPerRun).toBe(100);
		}
	});

	test("maxStepsPerRun rejects zero or negative", () => {
		expect(FiveXConfigSchema.safeParse({ maxStepsPerRun: 0 }).success).toBe(
			false,
		);
		expect(FiveXConfigSchema.safeParse({ maxStepsPerRun: -1 }).success).toBe(
			false,
		);
	});

	// -----------------------------------------------------------------------
	// Backward compatibility — deprecated keys still parse
	// -----------------------------------------------------------------------

	test("deprecated keys still parse and have defaults", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.maxReviewIterations).toBe(5);
			expect(result.data.maxQualityRetries).toBe(3);
			expect(result.data.maxAutoIterations).toBe(10);
			expect(result.data.maxAutoRetries).toBe(3);
		}
	});

	// -----------------------------------------------------------------------
	// Plugin config passthrough
	// -----------------------------------------------------------------------

	test("plugin config passthrough: arbitrary keys survive parsing", () => {
		const result = FiveXConfigSchema.safeParse({
			author: { provider: "codex" },
			codex: { apiKey: "sk-123", region: "us-east-1" },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			// .passthrough() preserves unknown keys
			const raw = result.data as Record<string, unknown>;
			expect(raw.codex).toEqual({ apiKey: "sk-123", region: "us-east-1" });
		}
	});

	test("multiple plugin configs survive parsing", () => {
		const result = FiveXConfigSchema.safeParse({
			author: { provider: "codex" },
			reviewer: { provider: "@acme/provider-foo" },
			codex: { apiKey: "sk-123" },
			"@acme/provider-foo": { endpoint: "https://example.com" },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const raw = result.data as Record<string, unknown>;
			expect(raw.codex).toEqual({ apiKey: "sk-123" });
			expect(raw["@acme/provider-foo"]).toEqual({
				endpoint: "https://example.com",
			});
		}
	});

	// -----------------------------------------------------------------------
	// Unknown keys warn (except keys matching a configured provider name)
	// -----------------------------------------------------------------------

	test("unknown root keys produce warnings", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { unknownThing: true };`,
			);
			await loadConfig(tmp);
			expect(errors.join("\n")).toContain('Unknown config key "unknownThing"');
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("provider-matching top-level keys do NOT produce warnings", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { provider: "codex" }, codex: { apiKey: "sk-123" } };`,
			);
			await loadConfig(tmp);
			// "codex" matches author.provider, so no warning
			const allErrors = errors.join("\n");
			expect(allErrors).not.toContain("codex");
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("non-provider unknown keys still warn even when provider keys are present", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { provider: "codex" }, codex: { apiKey: "sk-123" }, bogus: true };`,
			);
			await loadConfig(tmp);
			const allErrors = errors.join("\n");
			expect(allErrors).not.toContain('"codex"');
			expect(allErrors).toContain('"bogus"');
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("opencode is a known key — no warning even without provider reference", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { opencode: { url: "http://localhost:3000" } };`,
			);
			await loadConfig(tmp);
			const allErrors = errors.join("\n");
			expect(allErrors).not.toContain("opencode");
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unknown opencode sub-keys warn", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { opencode: { url: "http://localhost:3000", badKey: true } };`,
			);
			await loadConfig(tmp);
			const allErrors = errors.join("\n");
			expect(allErrors).toContain('"opencode.badKey"');
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// Deprecated keys warn
	// -----------------------------------------------------------------------

	test("maxAutoIterations produces deprecation warning", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxAutoIterations: 20 };`,
			);
			await loadConfig(tmp);
			const allErrors = errors.join("\n");
			expect(allErrors).toContain("maxAutoIterations");
			expect(allErrors).toContain("maxStepsPerRun");
			expect(allErrors).toContain("deprecated");
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("provider field in agent config does NOT warn", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { provider: "opencode", model: "gpt-4" } };`,
			);
			await loadConfig(tmp);
			const allErrors = errors.join("\n");
			expect(allErrors).toBe("");
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// applyModelOverrides — provider and opencode URL overrides
	// -----------------------------------------------------------------------

	test("applyModelOverrides applies author provider override", () => {
		const config = FiveXConfigSchema.parse({});
		const overridden = applyModelOverrides(config, {
			authorProvider: "codex",
		});
		expect(overridden.author.provider).toBe("codex");
		// reviewer unchanged
		expect(overridden.reviewer.provider).toBe("opencode");
	});

	test("applyModelOverrides applies reviewer provider override", () => {
		const config = FiveXConfigSchema.parse({});
		const overridden = applyModelOverrides(config, {
			reviewerProvider: "@acme/provider-foo",
		});
		expect(overridden.reviewer.provider).toBe("@acme/provider-foo");
		// author unchanged
		expect(overridden.author.provider).toBe("opencode");
	});

	test("applyModelOverrides applies opencode URL override", () => {
		const config = FiveXConfigSchema.parse({});
		const overridden = applyModelOverrides(config, {
			opencodeUrl: "http://localhost:4000",
		});
		expect(overridden.opencode.url).toBe("http://localhost:4000");
	});

	test("applyModelOverrides applies model + provider together", () => {
		const config = FiveXConfigSchema.parse({
			author: { model: "config-model" },
		});
		const overridden = applyModelOverrides(config, {
			authorModel: "cli-model",
			authorProvider: "codex",
		});
		expect(overridden.author.model).toBe("cli-model");
		expect(overridden.author.provider).toBe("codex");
	});

	test("applyModelOverrides preserves existing values when not overridden", () => {
		const config = FiveXConfigSchema.parse({
			author: { provider: "codex", model: "gpt-4" },
			opencode: { url: "http://localhost:3000" },
		});
		const overridden = applyModelOverrides(config, {
			reviewerModel: "claude",
		});
		// Author unchanged
		expect(overridden.author.provider).toBe("codex");
		expect(overridden.author.model).toBe("gpt-4");
		// Opencode unchanged
		expect(overridden.opencode.url).toBe("http://localhost:3000");
		// Reviewer updated
		expect(overridden.reviewer.model).toBe("claude");
	});

	test("applyModelOverrides trims whitespace", () => {
		const config = FiveXConfigSchema.parse({});
		const overridden = applyModelOverrides(config, {
			authorProvider: "  codex  ",
			opencodeUrl: "  http://localhost:3000  ",
		});
		expect(overridden.author.provider).toBe("codex");
		expect(overridden.opencode.url).toBe("http://localhost:3000");
	});

	// -----------------------------------------------------------------------
	// Full config via loadConfig with v1 fields
	// -----------------------------------------------------------------------

	test("loadConfig parses v1 fields from config file", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default {
					author: { provider: "codex", model: "gpt-4" },
					reviewer: { provider: "opencode" },
					opencode: { url: "http://localhost:3000" },
					maxStepsPerRun: 100,
				};`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.provider).toBe("codex");
			expect(config.author.model).toBe("gpt-4");
			expect(config.reviewer.provider).toBe("opencode");
			expect(config.opencode.url).toBe("http://localhost:3000");
			expect(config.maxStepsPerRun).toBe(100);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("existing configs without v1 fields still work", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default {
					author: { model: "anthropic/claude-sonnet-4-6" },
					qualityGates: ["bun test"],
					maxReviewIterations: 3,
				};`,
			);
			const { config } = await loadConfig(tmp);
			// Defaults applied
			expect(config.author.provider).toBe("opencode");
			expect(config.reviewer.provider).toBe("opencode");
			expect(config.opencode.url).toBeUndefined();
			expect(config.maxStepsPerRun).toBe(50);
			// Explicit values preserved
			expect(config.author.model).toBe("anthropic/claude-sonnet-4-6");
			expect(config.qualityGates).toEqual(["bun test"]);
			expect(config.maxReviewIterations).toBe(3);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// P0.1: maxAutoIterations → maxStepsPerRun alias
	// -----------------------------------------------------------------------

	test("maxAutoIterations is honored as maxStepsPerRun when maxStepsPerRun absent", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxAutoIterations: 20 };`,
			);
			// Suppress deprecation warning output
			const original = console.error;
			console.error = () => {};
			try {
				const { config } = await loadConfig(tmp);
				expect(config.maxStepsPerRun).toBe(20);
			} finally {
				console.error = original;
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("explicit maxStepsPerRun takes precedence over maxAutoIterations", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxStepsPerRun: 100, maxAutoIterations: 20 };`,
			);
			const original = console.error;
			console.error = () => {};
			try {
				const { config } = await loadConfig(tmp);
				expect(config.maxStepsPerRun).toBe(100);
			} finally {
				console.error = original;
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("maxAutoIterations alias not applied when maxStepsPerRun is explicitly set", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxStepsPerRun: 30, maxAutoIterations: 5 };`,
			);
			const original = console.error;
			console.error = () => {};
			try {
				const { config } = await loadConfig(tmp);
				// Explicit maxStepsPerRun wins
				expect(config.maxStepsPerRun).toBe(30);
			} finally {
				console.error = original;
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// P2.2: CLI provider names suppress unknown-key warnings
	// -----------------------------------------------------------------------

	test("CLI provider names suppress unknown-key warnings for matching top-level keys", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			// Config file has a "codex" key but does NOT reference codex as a provider
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { codex: { apiKey: "sk-123" } };`,
			);
			// Without CLI provider names, "codex" would be unknown
			const { config: _noCliConfig } = await loadConfig(tmp);
			expect(errors.join("\n")).toContain('"codex"');

			// Reset errors
			errors.length = 0;

			// With CLI provider names, "codex" should be suppressed
			const { config: _withCliConfig } = await loadConfig(
				tmp,
				new Set(["codex"]),
			);
			expect(errors.join("\n")).not.toContain('"codex"');
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
