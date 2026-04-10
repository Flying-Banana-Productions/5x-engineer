/**
 * Unit tests for `5x config show` / `config set` / `config unset`.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as tomlParse } from "@decimalturn/toml-patch";
import {
	buildConfigFileRows,
	buildConfigShowOutput,
	configAdd,
	configRemove,
	configSet,
	configUnset,
	detectActiveConfigSource,
	discoverNearestTomlPath,
	resolveTargetConfigPath,
} from "../../../src/commands/config.handler.js";
import { resolveLayeredConfig } from "../../../src/config.js";
import {
	flattenConfig,
	getConfigRegistry,
	resolveWritableArrayConfigKey,
	resolveWritableConfigKey,
} from "../../../src/config-registry.js";
import { CliError } from "../../../src/output.js";

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

describe("resolveTargetConfigPath", () => {
	test("falls back to root 5x.toml when no nearest TOML", () => {
		const tmp = makeTmpDir();
		try {
			const { controlPlaneRoot, targetPath } = resolveTargetConfigPath({
				startDir: tmp,
				contextDir: tmp,
			});
			expect(controlPlaneRoot).toBe(resolve(tmp));
			expect(targetPath).toBe(join(tmp, "5x.toml"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("--local targets 5x.toml.local beside nearest TOML", () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, "maxStepsPerRun = 1");
			const { targetPath } = resolveTargetConfigPath({
				startDir: tmp,
				contextDir: tmp,
				local: true,
			});
			expect(targetPath).toBe(join(tmp, "5x.toml.local"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project nearest 5x.toml is preferred over root", () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, '[author]\nprovider = "root"');
			const sub = join(tmp, "packages", "api");
			mkdirSync(sub, { recursive: true });
			writeFileSync(
				join(sub, "5x.toml"),
				["[author]", 'model = "sub"'].join("\n"),
				"utf-8",
			);
			const { targetPath } = resolveTargetConfigPath({
				startDir: tmp,
				contextDir: sub,
			});
			expect(targetPath).toBe(join(sub, "5x.toml"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("discoverNearestTomlPath", () => {
	test("finds nested 5x.toml before root", () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, "x = 1");
			const sub = join(tmp, "a", "b");
			mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, "5x.toml"), "y = 2\n", "utf-8");
			expect(discoverNearestTomlPath(sub, tmp)).toBe(join(sub, "5x.toml"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveWritableConfigKey", () => {
	test("rejects exact record key", () => {
		const r = resolveWritableConfigKey(
			"author.harnessModels",
			getConfigRegistry(),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("dotted");
		}
	});

	test("accepts record descendant", () => {
		const r = resolveWritableConfigKey(
			"author.harnessModels.opencode",
			getConfigRegistry(),
		);
		expect(r.ok).toBe(true);
	});

	test("rejects array key", () => {
		const r = resolveWritableConfigKey("qualityGates", getConfigRegistry());
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("config add");
		}
	});
});

describe("resolveWritableArrayConfigKey", () => {
	test("accepts qualityGates", () => {
		const r = resolveWritableArrayConfigKey(
			"qualityGates",
			getConfigRegistry(),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.meta.type).toBe("string[]");
		}
	});

	test("rejects non-array key", () => {
		const r = resolveWritableArrayConfigKey(
			"maxStepsPerRun",
			getConfigRegistry(),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("not an array key");
		}
	});

	test("rejects record descendant", () => {
		const r = resolveWritableArrayConfigKey(
			"author.harnessModels.opencode",
			getConfigRegistry(),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("array keys");
		}
	});
});

describe("config set (unit)", () => {
	test("creates valid TOML for top-level key in empty project", async () => {
		const tmp = makeTmpDir();
		try {
			await configSet({
				key: "maxStepsPerRun",
				value: "500",
				startDir: tmp,
				contextDir: tmp,
			});
			const text = readFileSync(join(tmp, "5x.toml"), "utf-8");
			const parsed = tomlParse(text) as Record<string, unknown>;
			expect(parsed.maxStepsPerRun).toBe(500);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("creates nested tables for dotted key", async () => {
		const tmp = makeTmpDir();
		try {
			await configSet({
				key: "author.harnessModels.opencode",
				value: "my-model",
				startDir: tmp,
				contextDir: tmp,
			});
			const text = readFileSync(join(tmp, "5x.toml"), "utf-8");
			const parsed = tomlParse(text) as Record<string, unknown>;
			const author = parsed.author as Record<string, unknown>;
			const hm = author.harnessModels as Record<string, unknown>;
			expect(hm.opencode).toBe("my-model");
			// Inline table or header form — both are valid
			expect(text.includes("opencode") && text.includes("my-model")).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("preserves comments on existing file", async () => {
		const tmp = makeTmpDir();
		try {
			const original = [
				"# keep this comment",
				"maxReviewIterations = 3",
				"",
			].join("\n");
			writeFileSync(join(tmp, "5x.toml"), original, "utf-8");
			await configSet({
				key: "maxStepsPerRun",
				value: "400",
				startDir: tmp,
				contextDir: tmp,
			});
			const text = readFileSync(join(tmp, "5x.toml"), "utf-8");
			expect(text).toContain("# keep this comment");
			expect(text).toContain("maxStepsPerRun");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("--local writes 5x.toml.local", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, 'author.provider = "x"');
			await configSet({
				key: "author.model",
				value: "m",
				local: true,
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml.local"))).toBe(true);
			const loc = readFileSync(join(tmp, "5x.toml.local"), "utf-8");
			expect(loc).toContain("model");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project context targets sub-project 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, '[author]\nprovider = "root"');
			const sub = join(tmp, "packages", "api");
			mkdirSync(sub, { recursive: true });
			writeFileSync(
				join(sub, "5x.toml"),
				["[paths]", 'plans = "p"'].join("\n"),
				"utf-8",
			);
			await configSet({
				key: "author.provider",
				value: "sub-prov",
				startDir: tmp,
				contextDir: sub,
			});
			const text = readFileSync(join(sub, "5x.toml"), "utf-8");
			expect(text).toContain("sub-prov");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("db.path from sub-project context errors", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, '[db]\npath = ".5x/5x.db"');
			const sub = join(tmp, "packages", "api");
			mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, "5x.toml"), '[paths]\nplans = "x"\n', "utf-8");
			await expect(
				configSet({
					key: "db.path",
					value: ".5x/other.db",
					startDir: tmp,
					contextDir: sub,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("wrong type for number key errors", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				configSet({
					key: "maxStepsPerRun",
					value: "not-a-number",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unknown key errors", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				configSet({
					key: "not.a.real.key",
					value: "x",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("boolean only accepts true/false", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				configSet({
					key: "skipQualityGates",
					value: "yes",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("JS active source rejects set", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				"export default { author: { provider: 'opencode' } }\n",
				"utf-8",
			);
			expect(detectActiveConfigSource(tmp, tmp)).toBe("js");
			await expect(
				configSet({
					key: "maxStepsPerRun",
					value: "100",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("config unset (unit)", () => {
	test("removes key and preserves others", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				["maxStepsPerRun = 100", "", "[author]", 'provider = "p"', ""].join(
					"\n",
				),
				"utf-8",
			);
			await configUnset({
				key: "maxStepsPerRun",
				startDir: tmp,
				contextDir: tmp,
			});
			const parsed = tomlParse(
				readFileSync(join(tmp, "5x.toml"), "utf-8"),
			) as Record<string, unknown>;
			expect(parsed.maxStepsPerRun).toBeUndefined();
			expect((parsed.author as Record<string, unknown>).provider).toBe("p");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("missing file is no-op", async () => {
		const tmp = makeTmpDir();
		try {
			await configUnset({
				key: "maxStepsPerRun",
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("last key removes file", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, "maxStepsPerRun = 1\n");
			await configUnset({
				key: "maxStepsPerRun",
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("JS active source rejects unset", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				"module.exports = { maxStepsPerRun: 50 }\n",
				"utf-8",
			);
			await expect(
				configUnset({
					key: "maxStepsPerRun",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("config add / remove (unit)", () => {
	test("add appends to empty implicit array", async () => {
		const tmp = makeTmpDir();
		try {
			await configAdd({
				key: "qualityGates",
				value: "bun test",
				startDir: tmp,
				contextDir: tmp,
			});
			const parsed = tomlParse(
				readFileSync(join(tmp, "5x.toml"), "utf-8"),
			) as Record<string, unknown>;
			expect(parsed.qualityGates).toEqual(["bun test"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("add duplicate is idempotent (no duplicate entries)", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, 'qualityGates = ["bun test"]\n');
			await configAdd({
				key: "qualityGates",
				value: "bun test",
				startDir: tmp,
				contextDir: tmp,
			});
			const parsed = tomlParse(
				readFileSync(join(tmp, "5x.toml"), "utf-8"),
			) as Record<string, unknown>;
			expect(parsed.qualityGates).toEqual(["bun test"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("remove drops an existing value", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, 'qualityGates = ["a", "b"]\n');
			await configRemove({
				key: "qualityGates",
				value: "a",
				startDir: tmp,
				contextDir: tmp,
			});
			const parsed = tomlParse(
				readFileSync(join(tmp, "5x.toml"), "utf-8"),
			) as Record<string, unknown>;
			expect(parsed.qualityGates).toEqual(["b"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("remove non-existent value is no-op", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, 'qualityGates = ["a"]\n');
			await configRemove({
				key: "qualityGates",
				value: "missing",
				startDir: tmp,
				contextDir: tmp,
			});
			const parsed = tomlParse(
				readFileSync(join(tmp, "5x.toml"), "utf-8"),
			) as Record<string, unknown>;
			expect(parsed.qualityGates).toEqual(["a"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("add/remove with --local uses 5x.toml.local", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, "maxStepsPerRun = 1\n");
			await configAdd({
				key: "qualityGates",
				value: "gate-a",
				local: true,
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml.local"))).toBe(true);
			await configRemove({
				key: "qualityGates",
				value: "gate-a",
				local: true,
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml.local"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("add/remove with sub-project --context targets same file as set", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, '[author]\nprovider = "root"');
			const sub = join(tmp, "packages", "api");
			mkdirSync(sub, { recursive: true });
			writeFileSync(
				join(sub, "5x.toml"),
				["[paths]", 'plans = "p"'].join("\n"),
				"utf-8",
			);
			const setPath = resolveTargetConfigPath({
				startDir: tmp,
				contextDir: sub,
			}).targetPath;
			const addPath = resolveTargetConfigPath({
				startDir: tmp,
				contextDir: sub,
			}).targetPath;
			expect(addPath).toBe(setPath);
			expect(addPath).toBe(join(sub, "5x.toml"));

			await configAdd({
				key: "qualityGates",
				value: "x",
				startDir: tmp,
				contextDir: sub,
			});
			await configRemove({
				key: "qualityGates",
				value: "x",
				startDir: tmp,
				contextDir: sub,
			});
			const subToml = readFileSync(join(sub, "5x.toml"), "utf-8");
			expect(subToml).toContain('plans = "p"');
			expect(subToml).not.toContain("qualityGates");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("JS active source rejects add", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				"export default { author: { provider: 'opencode' } }\n",
				"utf-8",
			);
			await expect(
				configAdd({
					key: "qualityGates",
					value: "x",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("JS active source rejects remove", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				"module.exports = { qualityGates: ['a'] }\n",
				"utf-8",
			);
			await expect(
				configRemove({
					key: "qualityGates",
					value: "a",
					startDir: tmp,
					contextDir: tmp,
				}),
			).rejects.toThrow(CliError);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("remove last element deletes key; empty file deleted", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, 'qualityGates = ["only"]\n');
			await configRemove({
				key: "qualityGates",
				value: "only",
				startDir: tmp,
				contextDir: tmp,
			});
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
