import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	canonicalizePlanPath,
	planSlugFromPath,
	resolvePlanArg,
} from "../../src/paths.js";

describe("planSlugFromPath", () => {
	test("extracts slug from POSIX path", () => {
		expect(planSlugFromPath("docs/development/001-feature.md")).toBe(
			"001-feature",
		);
	});

	test("extracts slug from Windows relative path", () => {
		expect(planSlugFromPath("docs\\development\\001-feature.md")).toBe(
			"001-feature",
		);
	});

	test("extracts slug from Windows absolute path", () => {
		expect(
			planSlugFromPath("D:\\github\\repo\\docs\\development\\001-feature.md"),
		).toBe("001-feature");
	});
});

describe("canonicalizePlanPath", () => {
	test("returns a stable absolute path for missing files", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-missing-"));
		try {
			const p = resolve(join(tmp, "missing.md"));
			expect(canonicalizePlanPath(p)).toBe(p);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("resolves symlinks to real path when possible", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-"));
		try {
			const target = join(tmp, "plan.md");
			const link = join(tmp, "plan-link.md");
			writeFileSync(target, "# Plan\n");
			symlinkSync(target, link);
			expect(canonicalizePlanPath(link)).toBe(canonicalizePlanPath(target));
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("resolvePlanArg", () => {
	test("returns absolute path when file exists at that path", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-resolve-"));
		try {
			const file = join(tmp, "plan.md");
			writeFileSync(file, "# Plan\n");
			expect(resolvePlanArg(file, "/other")).toBe(file);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("bare filename falls back to plansDir when not in CWD", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-resolve-"));
		const plansDir = join(tmp, "plans");
		try {
			mkdirSync(plansDir, { recursive: true });
			// Use a unique filename unlikely to exist in CWD
			const name = `5x-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
			writeFileSync(join(plansDir, name), "# Feature\n");
			const result = resolvePlanArg(name, plansDir);
			expect(result).toBe(resolve(join(plansDir, name)));
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("returns CWD-resolved path when neither location has the file", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-resolve-"));
		try {
			const missing = join(tmp, "nonexistent.md");
			expect(resolvePlanArg(missing, join(tmp, "plans"))).toBe(missing);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("existing absolute path takes precedence over plansDir", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-resolve-"));
		const plansDir = join(tmp, "plans");
		try {
			mkdirSync(plansDir, { recursive: true });
			const direct = join(tmp, "x.md");
			writeFileSync(direct, "# Direct\n");
			writeFileSync(join(plansDir, "x.md"), "# Plans\n");
			expect(resolvePlanArg(direct, plansDir)).toBe(direct);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
