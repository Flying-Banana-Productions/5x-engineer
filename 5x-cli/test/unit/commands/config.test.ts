/**
 * Unit tests for `5x config show` — registry-backed output and resolution.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildConfigFileRows,
	buildConfigShowOutput,
} from "../../../src/commands/config.handler.js";
import { resolveLayeredConfig } from "../../../src/config.js";
import {
	flattenConfig,
	getConfigRegistry,
} from "../../../src/config-registry.js";

function makeTmpDir(prefix = "5x-cfg-unit"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeToml(dir: string, content: string): void {
	writeFileSync(join(dir, "5x.toml"), content, "utf-8");
}

describe("flattenConfig", () => {
	test("expands nested objects and record maps", () => {
		const flat = flattenConfig({
			author: {
				provider: "p",
				harnessModels: { opencode: "m1", cursor: "m2" },
			},
			qualityGates: ["bun test"],
		} as Record<string, unknown>);
		expect(flat.get("author.provider")).toBe("p");
		expect(flat.get("author.harnessModels.opencode")).toBe("m1");
		expect(flat.get("author.harnessModels.cursor")).toBe("m2");
		expect(flat.get("qualityGates")).toEqual(["bun test"]);
	});
});

describe("buildConfigShowOutput", () => {
	test("includes every non-record registry key in entries", async () => {
		const tmp = makeTmpDir();
		try {
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			const keys = new Set(out.entries.map((e) => e.key));
			const registry = getConfigRegistry().filter((m) => m.type !== "record");
			for (const m of registry) {
				expect(keys.has(m.key), `missing ${m.key}`).toBe(true);
			}
			expect(out.files).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("paths.* defaults are absolute under control plane root", async () => {
		const tmp = makeTmpDir();
		try {
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			const plans = out.entries.find((e) => e.key === "paths.plans");
			expect(plans?.default).toBe(resolve(tmp, "docs/development"));
			expect(plans?.value).toBe(resolve(tmp, "docs/development"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("isLocal is true for keys present only in local overlay", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, ["[author]", 'provider = "from-main"'].join("\n"));
			writeFileSync(
				join(tmp, "5x.toml.local"),
				["[author]", 'model = "from-local"'].join("\n"),
				"utf-8",
			);
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			const provider = out.entries.find((e) => e.key === "author.provider");
			const model = out.entries.find((e) => e.key === "author.model");
			expect(provider?.isLocal).toBe(false);
			expect(model?.isLocal).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("passthrough keys are marked unrecognized", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				["[author]", 'provider = "x"', "", "[pluginx]", "foo = 1"].join("\n"),
			);
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			const p = out.entries.find((e) => e.key === "pluginx.foo");
			expect(p?.description).toBe("(unrecognized)");
			expect(p?.type).toBe("unknown");
			expect(p?.value).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("files list matches layered resolution paths", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, "maxStepsPerRun = 100");
			writeFileSync(join(tmp, "5x.toml.local"), "skipQualityGates = true\n");
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			expect(out.files[0]).toBe(join(tmp, "5x.toml"));
			expect(out.files[1]).toBe(join(tmp, "5x.toml.local"));
			const rows = buildConfigFileRows(layered);
			expect(rows.map((r) => r.label)).toEqual(["root", "local"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("--key filter (unit)", () => {
	test("find single entry by key", async () => {
		const tmp = makeTmpDir();
		try {
			const layered = await resolveLayeredConfig(tmp);
			const out = buildConfigShowOutput(layered, tmp);
			const e = out.entries.find((k) => k.key === "maxStepsPerRun");
			expect(e?.value).toBe(250);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("config resolution via resolveLayeredConfig", () => {
	test("resolves custom values from 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"maxReviewIterations = 7",
					"maxQualityRetries = 5",
					"",
					"[author]",
					'provider = "custom-provider"',
					'model = "custom-model"',
					"",
					"[paths]",
					'plans = "my-plans"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp);
			expect(result.config.maxReviewIterations).toBe(7);
			expect(result.config.maxQualityRetries).toBe(5);
			expect(result.config.author.provider).toBe("custom-provider");
			expect(result.config.author.model).toBe("custom-model");
			expect(result.config.paths.plans).toBe(join(tmp, "my-plans"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("layered resolution: sub-project overrides root values", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"maxReviewIterations = 7",
					"",
					"[author]",
					'provider = "root-provider"',
					'model = "root-model"',
				].join("\n"),
			);

			const subDir = join(tmp, "packages", "api");
			mkdirSync(subDir, { recursive: true });
			writeToml(
				subDir,
				[
					"[author]",
					'model = "sub-model"',
					"",
					"[paths]",
					'plans = "sub-plans"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			expect(result.config.author.model).toBe("sub-model");
			expect(result.config.paths.plans).toBe(join(subDir, "sub-plans"));
			expect(result.config.author.provider).toBe("root-provider");
			expect(result.config.maxReviewIterations).toBe(7);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("defaults returned when no config file exists", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await resolveLayeredConfig(tmp);
			expect(result.config.author.provider).toBe("opencode");
			expect(result.config.maxReviewIterations).toBe(5);
			expect(result.config.maxQualityRetries).toBe(3);
			expect(result.config.maxStepsPerRun).toBe(250);
			expect(result.rootConfigPath).toBeNull();
			expect(result.isLayered).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("passthrough/plugin config keys are preserved", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"[author]",
					'provider = "acme"',
					"",
					"[acme]",
					'apiKey = "sk-test"',
					'region = "us-east-1"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp);
			const configAny = result.config as Record<string, unknown>;
			expect(configAny.acme).toBeDefined();
			const acme = configAny.acme as Record<string, unknown>;
			expect(acme.apiKey).toBe("sk-test");
			expect(acme.region).toBe("us-east-1");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
