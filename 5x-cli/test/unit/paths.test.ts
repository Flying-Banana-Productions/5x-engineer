import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	canonicalizePlanPath,
	isPathUnder,
	planSlugFromPath,
	realpathExisting,
	relativePathUnder,
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
			expect(canonicalizePlanPath(p)).toBe(
				join(realpathSync(tmp), "missing.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("resolves missing files through the parent's realpath", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-missing-parent-"));
		try {
			expect(canonicalizePlanPath(join(tmp, "missing.md"))).toBe(
				realpathExisting(join(tmp, "missing.md")),
			);
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

describe("physical path identity", () => {
	test("realpaths nested missing paths through the longest existing ancestor", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-nested-"));
		try {
			const target = join(tmp, "target");
			const alias = join(tmp, "alias");
			mkdirSync(target);
			symlinkSync(target, alias, "dir");

			const missing = join(alias, "new", "subproject", "plan.md");
			const expected = join(
				realpathSync(target),
				"new",
				"subproject",
				"plan.md",
			);
			expect(realpathExisting(missing)).toBe(expected);
			expect(relativePathUnder(missing, target)).toBe(
				join("new", "subproject", "plan.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("rejects traversal through a symlink outside the parent", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-paths-escape-"));
		try {
			const root = join(tmp, "root");
			const outside = join(tmp, "outside");
			mkdirSync(root);
			mkdirSync(outside);
			symlinkSync(outside, join(root, "escape"), "dir");

			const escaped = join(root, "escape", "missing", "plan.md");
			expect(isPathUnder(escaped, root)).toBe(false);
			expect(relativePathUnder(escaped, root)).toBeNull();
			expect(isPathUnder("relative/plan.md", root)).toBe(false);
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

describe("realpathExisting", () => {
	test("realpaths nested missing components through the longest existing prefix", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-nested-missing-"));
		try {
			const realDir = join(tmp, "real");
			mkdirSync(realDir);
			const alias = join(tmp, "alias");
			symlinkSync(realDir, alias);
			const nested = join(alias, "new", "subproject", "file.md");
			const expected = join(
				realpathSync(realDir),
				"new",
				"subproject",
				"file.md",
			);
			expect(realpathExisting(nested)).toBe(expected);
			expect(isPathUnder(nested, realDir)).toBe(true);
			expect(isPathUnder(nested, alias)).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("canonicalizes nested missing paths through a macOS /var alias", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-nested-alias-"));
		try {
			const realRoot = realpathSync(tmp);
			const nestedMissing = join(tmp, "new", "subproject");
			expect(realpathExisting(nestedMissing)).toBe(
				join(realRoot, "new", "subproject"),
			);
			expect(isPathUnder(nestedMissing, tmp)).toBe(true);
			expect(isPathUnder(nestedMissing, realRoot)).toBe(true);

			if (realRoot.startsWith("/private/var/")) {
				const aliasRoot = realRoot.replace(/^\/private\/var\//, "/var/");
				const aliasNested = join(aliasRoot, "new", "subproject");
				expect(realpathExisting(aliasNested)).toBe(
					join(realRoot, "new", "subproject"),
				);
				expect(isPathUnder(aliasNested, realRoot)).toBe(true);
				expect(
					isPathUnder(join(realRoot, "new", "subproject"), aliasRoot),
				).toBe(true);
			}
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("isPathUnder", () => {
	test("treats symlink prefixes as the same tree", () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-under-"));
		try {
			mkdirSync(join(tmp, "docs"), { recursive: true });
			const child = join(tmp, "docs", "plan.md");
			writeFileSync(child, "# Plan\n");
			const realRoot = realpathSync(tmp);
			expect(isPathUnder(child, tmp)).toBe(true);
			expect(isPathUnder(child, realRoot)).toBe(true);
			expect(isPathUnder(realpathSync(child), tmp)).toBe(true);
			expect(isPathUnder(join(tmp, "docs"), tmp)).toBe(true);
			expect(isPathUnder(tmp, tmp)).toBe(true);

			if (realRoot.startsWith("/private/var/")) {
				const aliasRoot = realRoot.replace(/^\/private\/var\//, "/var/");
				expect(isPathUnder(join(realRoot, "docs", "plan.md"), aliasRoot)).toBe(
					true,
				);
				expect(isPathUnder(join(aliasRoot, "docs", "plan.md"), realRoot)).toBe(
					true,
				);
			}
			expect(isPathUnder("/tmp/outside.md", tmp)).toBe(false);
			expect(isPathUnder("relative/plan.md", tmp)).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
