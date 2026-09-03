import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FiveXConfigSchema } from "../../src/config.js";
import {
	buildConfigRegistry,
	computeLocalKeys,
	getConfigRegistry,
} from "../../src/config-registry.js";

describe("config-registry", () => {
	test("buildConfigRegistry walks a plain ZodObject", () => {
		const schema = z.object({
			a: z.string().default("x").describe("field a"),
			b: z.number().default(1).describe("field b"),
		});
		const reg = buildConfigRegistry(schema);
		expect(reg.map((e) => e.key).sort()).toEqual(["a", "b"]);
		expect(reg.find((e) => e.key === "a")).toMatchObject({
			type: "string",
			default: "x",
			description: "field a",
		});
	});

	test("spot-check expected dotted keys", () => {
		const keys = new Set(getConfigRegistry().map((e) => e.key));
		expect(keys.has("author.provider")).toBe(true);
		expect(keys.has("paths.templates.plan")).toBe(true);
		expect(keys.has("paths.records")).toBe(true);
		expect(keys.has("records.redact")).toBe(true);
		expect(keys.has("records.actor")).toBe(true);
		expect(keys.has("maxStepsPerRun")).toBe(true);
		expect(keys.has("qualityGates")).toBe(true);
	});

	test("every entry has a non-empty description", () => {
		for (const entry of getConfigRegistry()) {
			expect(entry.description.trim().length).toBeGreaterThan(0);
		}
	});

	test("defaults match Zod schema parse({}) output", () => {
		const parsed = FiveXConfigSchema.parse({});
		const byKey = new Map(getConfigRegistry().map((e) => [e.key, e]));

		function expectDefault(path: string, expected: unknown) {
			const meta = byKey.get(path);
			expect(meta, `missing ${path}`).toBeDefined();
			expect(meta?.default).toEqual(expected);
			const leaf = path
				.split(".")
				.reduce((o, k) => (o as Record<string, unknown>)[k], parsed as unknown);
			expect(leaf).toEqual(expected);
		}

		expectDefault("author.provider", parsed.author.provider);
		expectDefault(
			"author.continuePhaseSessions",
			parsed.author.continuePhaseSessions,
		);
		expectDefault("author.delegationMode", parsed.author.delegationMode);
		expectDefault("paths.plans", parsed.paths.plans);
		expectDefault("paths.records", parsed.paths.records);
		expectDefault("paths.templates.plan", parsed.paths.templates.plan);
		expectDefault("db.path", parsed.db.path);
		expectDefault("qualityGates", parsed.qualityGates);
		expectDefault("skipQualityGates", parsed.skipQualityGates);
		expectDefault("maxStepsPerRun", parsed.maxStepsPerRun);
		expectDefault("maxQualityRetries", parsed.maxQualityRetries);
		expectDefault("maxAutoRetries", parsed.maxAutoRetries);
		expectDefault("records.redact", parsed.records.redact);
	});

	test("optional leaves have undefined default in registry", () => {
		const byKey = new Map(getConfigRegistry().map((e) => [e.key, e]));
		expect(byKey.get("author.model")?.default).toBeUndefined();
		expect(byKey.get("opencode.url")?.default).toBeUndefined();
		expect(byKey.get("records.actor")?.default).toBeUndefined();
	});

	test("deprecated keys are flagged", () => {
		const byKey = new Map(getConfigRegistry().map((e) => [e.key, e]));
		expect(byKey.get("maxAutoIterations")?.deprecated).toBe(true);
		expect(byKey.get("maxReviewIterations")?.deprecated).toBe(true);
		expect(byKey.get("maxStepsPerRun")?.deprecated).toBeUndefined();
	});

	test("harnessModels has type record", () => {
		const author = getConfigRegistry().find(
			(e) => e.key === "author.harnessModels",
		);
		const reviewer = getConfigRegistry().find(
			(e) => e.key === "reviewer.harnessModels",
		);
		expect(author?.type).toBe("record");
		expect(reviewer?.type).toBe("record");
	});

	test("harness freshness keys surface with type, default, and description", () => {
		const byKey = new Map(getConfigRegistry().map((e) => [e.key, e]));

		const warnings = byKey.get("harness.freshnessWarnings");
		expect(warnings?.type).toBe("enum");
		expect(warnings?.allowedValues?.sort()).toEqual(["off", "on"]);
		expect(warnings?.default).toBe("on");
		expect(warnings?.description).toContain("no longer match current config");

		const autoSync = byKey.get("harness.autoSync");
		expect(autoSync?.type).toBe("boolean");
		expect(autoSync?.default).toBe(false);
		expect(autoSync?.description).toContain("lossless");
	});

	test("harness.autoSync defaults to false with no harness table in config", () => {
		// The default posture must survive a `5x.toml` that never mentions the
		// key — auto-refresh is opt-in, and an absent table is not consent.
		expect(FiveXConfigSchema.parse({}).harness.autoSync).toBe(false);
		expect(FiveXConfigSchema.parse({}).harness.freshnessWarnings).toBe("on");
		expect(
			FiveXConfigSchema.parse({ author: { model: "m" } }).harness.autoSync,
		).toBe(false);
	});

	test("records keys surface with type, default, and description", () => {
		const byKey = new Map(getConfigRegistry().map((e) => [e.key, e]));

		const recordsPath = byKey.get("paths.records");
		expect(recordsPath?.type).toBe("string");
		expect(recordsPath?.default).toBe("docs/development/runs");
		expect(recordsPath?.description).toContain("git-tracked run records");

		const redact = byKey.get("records.redact");
		expect(redact?.type).toBe("string[]");
		expect(redact?.default).toEqual([]);
		expect(redact?.description).toContain("drop before writing");

		const actor = byKey.get("records.actor");
		expect(actor?.type).toBe("string");
		expect(actor?.default).toBeUndefined();
		expect(actor?.description).toContain("Never inferred");
	});

	test("qualityGates has type string[]", () => {
		const q = getConfigRegistry().find((e) => e.key === "qualityGates");
		expect(q?.type).toBe("string[]");
	});

	test("author.delegationMode lists enum values", () => {
		const d = getConfigRegistry().find(
			(e) => e.key === "author.delegationMode",
		);
		expect(d?.type).toBe("enum");
		expect(d?.allowedValues?.sort()).toEqual(["invoke", "native"]);
	});

	test("getConfigRegistry is memoized", () => {
		const a = getConfigRegistry();
		const b = getConfigRegistry();
		expect(a).toBe(b);
	});

	describe("computeLocalKeys", () => {
		test("empty array yields empty set", () => {
			expect([...computeLocalKeys([])]).toEqual([]);
		});

		test("single local with author.provider", () => {
			const keys = computeLocalKeys([{ author: { provider: "claude-code" } }]);
			expect(keys.has("author.provider")).toBe(true);
			expect(keys.size).toBe(1);
		});

		test("nested record key author.harnessModels.opencode", () => {
			const keys = computeLocalKeys([
				{
					author: {
						harnessModels: { opencode: "gpt-5" },
					},
				},
			]);
			expect(keys.has("author.harnessModels.opencode")).toBe(true);
		});

		test("multiple local raws union overlapping keys", () => {
			const keys = computeLocalKeys([
				{ author: { provider: "a" } },
				{ maxStepsPerRun: 99, author: { model: "m" } },
			]);
			expect(keys.has("author.provider")).toBe(true);
			expect(keys.has("author.model")).toBe(true);
			expect(keys.has("maxStepsPerRun")).toBe(true);
		});
	});
});
