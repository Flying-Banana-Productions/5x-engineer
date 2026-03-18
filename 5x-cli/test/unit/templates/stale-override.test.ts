import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadTemplate,
	setTemplateOverrideDir,
} from "../../../src/templates/loader.js";

describe("stale override version warning", () => {
	let tmpDir: string;

	afterEach(() => {
		setTemplateOverrideDir(null);
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	test("warns when override version is older than bundled version", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-stale-"));
		// Write a v1 override — bundled templates are now at v2
		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				'step_name: "author:generate-plan"',
				"---",
				"STALE OVERRIDE: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);

		const origStderr = console.error;
		const stderrLines: string[] = [];
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map(String).join(" "));
		};

		try {
			setTemplateOverrideDir(tmpDir);
			const { metadata, body } = loadTemplate("author-generate-plan");

			// Should still use the override (warn-only)
			expect(body).toContain("STALE OVERRIDE:");
			expect(metadata.version).toBe(1);

			// Should have emitted a stale warning
			expect(stderrLines.some((l) => l.includes("on-disk override (v1)"))).toBe(
				true,
			);
			expect(
				stderrLines.some((l) => l.includes("older than bundled (v2)")),
			).toBe(true);
			expect(
				stderrLines.some((l) =>
					l.includes("5x init --install-templates --force"),
				),
			).toBe(true);
		} finally {
			console.error = origStderr;
		}
	});

	test("no warning when override version matches bundled version", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-current-"));
		// Write a v2 override — same as bundled
		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 2",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				'step_name: "author:generate-plan"',
				"---",
				"CURRENT OVERRIDE: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);

		const origStderr = console.error;
		const stderrLines: string[] = [];
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map(String).join(" "));
		};

		try {
			setTemplateOverrideDir(tmpDir);
			const { metadata, body } = loadTemplate("author-generate-plan");

			// Should use the override
			expect(body).toContain("CURRENT OVERRIDE:");
			expect(metadata.version).toBe(2);

			// Should NOT have emitted a stale warning
			expect(stderrLines.some((l) => l.includes("older than bundled"))).toBe(
				false,
			);
		} finally {
			console.error = origStderr;
		}
	});

	test("no warning when override is a user-only template not in bundled registry", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-useronly-"));
		// Write a template that doesn't exist in the bundled TEMPLATES registry
		writeFileSync(
			join(tmpDir, "custom-user-template.md"),
			[
				"---",
				"name: custom-user-template",
				"version: 1",
				"variables:",
				"  - some_var",
				"---",
				"User template {{some_var}}",
			].join("\n"),
		);

		const origStderr = console.error;
		const stderrLines: string[] = [];
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map(String).join(" "));
		};

		try {
			setTemplateOverrideDir(tmpDir);
			// This will throw because the template doesn't exist in TEMPLATES
			// and is also not loaded from override (loadTemplate only loads
			// override for known templates or falls back to TEMPLATES).
			// Actually, loadTemplate WILL load from override even if not in
			// TEMPLATES — but only if the override file exists. The check
			// is: if raw is still undefined after override AND TEMPLATES,
			// then throw. Here the override sets raw, so it should work.
			const { body } = loadTemplate("custom-user-template");
			expect(body).toContain("User template");

			// Should NOT have emitted a stale warning
			expect(stderrLines.some((l) => l.includes("older than bundled"))).toBe(
				false,
			);
		} finally {
			console.error = origStderr;
		}
	});
});
