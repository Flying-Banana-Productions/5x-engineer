import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvVars, loadEnvFromDirectory, parseDotenv } from "../src/env.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("env helpers", () => {
	test("parseDotenv supports comments, export, and quotes", () => {
		const parsed = parseDotenv(`
# comment
FOO=bar
export BAZ="line\\nvalue"
QUX=' spaced value '
INLINE=yes # ignored
`);

		expect(parsed.FOO).toBe("bar");
		expect(parsed.BAZ).toBe("line\nvalue");
		expect(parsed.QUX).toBe(" spaced value ");
		expect(parsed.INLINE).toBe("yes");
	});

	test("loadEnvFromDirectory applies .env then .env.local precedence", () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, ".env"), "A=1\nSHARED=from-env\n");
			writeFileSync(join(tmp, ".env.local"), "B=2\nSHARED=from-local\n");

			const { vars, loadedFiles } = loadEnvFromDirectory(tmp);

			expect(vars).toEqual({ A: "1", B: "2", SHARED: "from-local" });
			expect(loadedFiles).toEqual([join(tmp, ".env"), join(tmp, ".env.local")]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("applyEnvVars overrides existing values", () => {
		const target: Record<string, string | undefined> = {
			DATABASE_TEST_URL: "old",
		};

		applyEnvVars(target, {
			DATABASE_TEST_URL: "new",
			OTHER_KEY: "value",
		});

		expect(target.DATABASE_TEST_URL).toBe("new");
		expect(target.OTHER_KEY).toBe("value");
	});
});
