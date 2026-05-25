import { describe, expect, test } from "bun:test";
import {
	buildCreateChatArgs,
	buildRunArgs,
	type RunArgContext,
} from "../../../../packages/provider-cursor-agent/src/cli-args.js";

function base(over: Partial<RunArgContext> = {}): RunArgContext {
	return {
		prompt: "hello",
		sessionId: "c6b62c6f-7ead-4fd6-9922-e952131177ff",
		cwd: "/tmp/project",
		...over,
	};
}

describe("buildCreateChatArgs", () => {
	test("returns create-chat subcommand", () => {
		expect(buildCreateChatArgs()).toEqual(["create-chat"]);
	});
});

describe("buildRunArgs", () => {
	test("includes baseline flags in order before optional flags", () => {
		const args = buildRunArgs(base());
		expect(args.slice(0, 8)).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--resume",
			"c6b62c6f-7ead-4fd6-9922-e952131177ff",
			"--workspace",
			"/tmp/project",
		]);
	});

	test("defaults include --force and --trust", () => {
		const args = buildRunArgs(base());
		expect(args).toContain("--force");
		expect(args).toContain("--trust");
	});

	test("force=false omits --force", () => {
		const args = buildRunArgs(base({ force: false }));
		expect(args).not.toContain("--force");
	});

	test("trust=false omits --trust", () => {
		const args = buildRunArgs(base({ trust: false }));
		expect(args).not.toContain("--trust");
	});

	test("includes --model when set", () => {
		const args = buildRunArgs(base({ model: "gpt-5" }));
		const i = args.indexOf("--model");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("gpt-5");
	});

	test("omits --model when empty string", () => {
		const args = buildRunArgs(base({ model: "" }));
		expect(args).not.toContain("--model");
	});

	test("includes --sandbox when set", () => {
		const args = buildRunArgs(base({ sandbox: "disabled" }));
		const i = args.indexOf("--sandbox");
		expect(args[i + 1]).toBe("disabled");
	});

	test("includes --approve-mcps when enabled", () => {
		const args = buildRunArgs(base({ approveMcps: true }));
		expect(args).toContain("--approve-mcps");
	});

	test("omits --approve-mcps by default", () => {
		const args = buildRunArgs(base());
		expect(args).not.toContain("--approve-mcps");
	});

	test("includes multiple --plugin-dir entries", () => {
		const args = buildRunArgs(
			base({ pluginDir: [".cursor/plugins/a", ".cursor/plugins/b"] }),
		);
		const first = args.indexOf("--plugin-dir");
		expect(args[first + 1]).toBe(".cursor/plugins/a");
		expect(args[first + 2]).toBe("--plugin-dir");
		expect(args[first + 3]).toBe(".cursor/plugins/b");
	});

	test("prompt is final positional argument", () => {
		const args = buildRunArgs(base({ prompt: "do the thing" }));
		expect(args.at(-1)).toBe("do the thing");
	});

	test("model appears before force/trust and prompt is last", () => {
		const args = buildRunArgs(
			base({
				model: "sonnet-4",
				force: true,
				trust: true,
				prompt: "final prompt",
			}),
		);
		const modelIdx = args.indexOf("--model");
		const forceIdx = args.indexOf("--force");
		const trustIdx = args.indexOf("--trust");
		expect(modelIdx).toBeLessThan(forceIdx);
		expect(forceIdx).toBeLessThan(trustIdx);
		expect(args.at(-1)).toBe("final prompt");
	});
});
