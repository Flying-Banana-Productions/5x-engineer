import { describe, expect, test } from "bun:test";
import {
	listBaseSkillNames,
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../src/skills/loader.js";
import {
	createRenderContext,
	type SkillRenderContext,
} from "../../../src/skills/renderer.js";

function makeMixedContext(
	authorNative: boolean,
	reviewerNative: boolean,
): SkillRenderContext {
	return {
		native: authorNative && reviewerNative,
		invoke: !authorNative && !reviewerNative,
		authorNative,
		reviewerNative,
		anyNative: authorNative || reviewerNative,
		anyInvoke: !authorNative || !reviewerNative,
	};
}

describe("shared skill template loader", () => {
	test("all shared templates load and parse frontmatter", () => {
		const names = listBaseSkillNames();
		expect(names).toEqual([
			"5x",
			"5x-windows",
			"5x-plan",
			"5x-plan-review",
			"5x-phase-execution",
		]);

		for (const name of names) {
			const nativeSkill = renderSkillByName(name, createRenderContext(true));
			expect(nativeSkill.name).toBe(name);
			expect(nativeSkill.description.length).toBeGreaterThan(10);
			expect(nativeSkill.content.startsWith("---\nname:")).toBe(true);
		}
	});

	test("renderAllSkillTemplates(native=true) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates(createRenderContext(true));
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("renderAllSkillTemplates(native=false) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates(createRenderContext(false));
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("native output contains Task tool/subagent_type references", () => {
		const native = renderAllSkillTemplates(createRenderContext(true))
			.map((s) => s.content)
			.join("\n\n");
		expect(native).toContain("Task tool");
		expect(native).toContain("subagent_type");
	});

	test("native output prefers native UI for human gates over 5x prompt in Tools sections", () => {
		const foundation = renderSkillByName(
			"5x",
			createRenderContext(true),
		).content;
		expect(foundation).toContain("native UI");
		expect(foundation).toContain("AskQuestion");
		const planReview = renderSkillByName(
			"5x-plan-review",
			createRenderContext(true),
		).content;
		expect(planReview).toContain("Human gates");
	});

	test("invoke output omits Task tool/subagent_type references", () => {
		const invoke = renderAllSkillTemplates(createRenderContext(false))
			.map((s) => s.content)
			.join("\n\n");
		expect(invoke).not.toContain("Task tool");
		expect(invoke).not.toContain("subagent_type");
	});

	test("frontmatter is identical in native/invoke contexts", () => {
		for (const name of listBaseSkillNames()) {
			const native = renderSkillByName(name, createRenderContext(true));
			const invoke = renderSkillByName(name, createRenderContext(false));
			expect(invoke.name).toBe(native.name);
			expect(invoke.description).toBe(native.description);
		}
	});

	test("invoke-only placeholders render from else branches", () => {
		const plan = renderSkillByName(
			"5x-plan",
			createRenderContext(false),
		).content;
		expect(plan).toContain("5x invoke author author-generate-plan");

		const foundation = renderSkillByName(
			"5x",
			createRenderContext(false),
		).content;
		expect(foundation).toContain("session_id");
	});

	test("foundation skill points Windows users at the optional supplemental skill", () => {
		const foundation = renderSkillByName(
			"5x",
			createRenderContext(true),
		).content;
		const windows = renderSkillByName(
			"5x-windows",
			createRenderContext(true),
		).content;

		expect(foundation).toContain("also load `5x-windows`");
		expect(windows).toContain("PowerShell");
		expect(windows).toContain("ConvertFrom-Json");
	});

	describe("mixed-mode delegation context combinations", () => {
		test("native/native renders only native blocks", () => {
			const ctx = makeMixedContext(true, true);
			for (const name of listBaseSkillNames()) {
				const skill = renderSkillByName(name, ctx);
				expect(skill.content).toBeTruthy();
				expect(skill.content.length).toBeGreaterThan(100);
			}

			// Foundation skill should have native delegation patterns
			const foundation = renderSkillByName("5x", ctx).content;
			expect(foundation).toContain("Task tool");
			expect(foundation).toContain("subagent_type");
			expect(foundation).not.toContain("5x invoke <author|reviewer>");
		});

		test("invoke/invoke renders only invoke blocks", () => {
			const ctx = makeMixedContext(false, false);
			for (const name of listBaseSkillNames()) {
				const skill = renderSkillByName(name, ctx);
				expect(skill.content).toBeTruthy();
				expect(skill.content.length).toBeGreaterThan(100);
			}

			// Foundation skill should have invoke patterns, not Task tool
			const foundation = renderSkillByName("5x", ctx).content;
			expect(foundation).toContain("5x invoke");
			expect(foundation).not.toContain("Task tool: subagent_type");
			expect(foundation).not.toContain("<Task tool:");
		});

		test("invoke/native (author invoke, reviewer native) renders correct mixed content", () => {
			const ctx = makeMixedContext(false, true);

			// Phase execution should have author invoke and reviewer native patterns
			const phaseExec = renderSkillByName("5x-phase-execution", ctx).content;

			// Should contain invoke patterns for author
			expect(phaseExec).toContain("5x invoke author");

			// Should contain native patterns for reviewer
			expect(phaseExec).toContain("Task tool");
			expect(phaseExec).toContain('subagent_type="5x-reviewer"');
		});

		test("native/invoke (author native, reviewer invoke) renders correct mixed content", () => {
			const ctx = makeMixedContext(true, false);

			// Phase execution should have author native and reviewer invoke patterns
			const phaseExec = renderSkillByName("5x-phase-execution", ctx).content;

			// Should contain native patterns for author
			expect(phaseExec).toContain('subagent_type="5x-code-author"');

			// Should contain invoke patterns for reviewer
			expect(phaseExec).toContain("5x invoke reviewer");
		});

		test("any_native blocks appear when at least one role is native", () => {
			const nativeNative = renderSkillByName(
				"5x",
				makeMixedContext(true, true),
			).content;
			const nativeInvoke = renderSkillByName(
				"5x",
				makeMixedContext(true, false),
			).content;
			const invokeNative = renderSkillByName(
				"5x",
				makeMixedContext(false, true),
			).content;
			const invokeInvoke = renderSkillByName(
				"5x",
				makeMixedContext(false, false),
			).content;

			// any_native blocks should appear in native/native and mixed modes
			expect(nativeNative).toContain("Task Reuse (Native)");
			expect(nativeInvoke).toContain("Task Reuse (Native)");
			expect(invokeNative).toContain("Task Reuse (Native)");

			// any_native blocks should NOT appear in invoke/invoke
			expect(invokeInvoke).not.toContain("Task Reuse (Native)");
		});

		test("any_invoke blocks appear when at least one role is invoke", () => {
			const nativeNative = renderSkillByName(
				"5x",
				makeMixedContext(true, true),
			).content;
			const nativeInvoke = renderSkillByName(
				"5x",
				makeMixedContext(true, false),
			).content;
			const invokeNative = renderSkillByName(
				"5x",
				makeMixedContext(false, true),
			).content;
			const invokeInvoke = renderSkillByName(
				"5x",
				makeMixedContext(false, false),
			).content;

			// any_invoke blocks should appear in invoke/invoke and mixed modes
			expect(nativeInvoke).toContain("Session Reuse (Invoke)");
			expect(invokeNative).toContain("Session Reuse (Invoke)");
			expect(invokeInvoke).toContain("Session Reuse (Invoke)");

			// any_invoke blocks should NOT appear in native/native
			expect(nativeNative).not.toContain("Session Reuse (Invoke)");
		});

		test("backward compatibility: native/native matches legacy { native: true }", () => {
			const legacy = renderSkillByName(
				"5x-phase-execution",
				createRenderContext(true),
			).content;
			const mixed = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(true, true),
			).content;

			// Both should have the same native-only content
			expect(legacy).toContain("Task tool");
			expect(mixed).toContain("Task tool");
			expect(legacy).toContain("subagent_type");
			expect(mixed).toContain("subagent_type");

			// Both should NOT have invoke patterns
			expect(legacy).not.toContain("5x invoke author author-next-phase");
			expect(mixed).not.toContain("5x invoke author author-next-phase");
		});

		test("backward compatibility: invoke/invoke matches legacy { native: false }", () => {
			const legacy = renderSkillByName(
				"5x-phase-execution",
				createRenderContext(false),
			).content;
			const mixed = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(false, false),
			).content;

			// Both should have invoke patterns
			expect(legacy).toContain("5x invoke author");
			expect(mixed).toContain("5x invoke author");

			// Both should NOT have Task tool patterns
			expect(legacy).not.toContain('subagent_type="5x-code-author"');
			expect(mixed).not.toContain('subagent_type="5x-code-author"');
		});

		test("backward compatibility: invoke/invoke foundation skill excludes native harness section", () => {
			// This is a P1.1 regression test - invoke/invoke mode should NOT include
			// the "Native harness" section since there are no native-delegated roles
			const legacy = renderSkillByName(
				"5x",
				createRenderContext(false),
			).content;
			const mixed = renderSkillByName(
				"5x",
				makeMixedContext(false, false),
			).content;

			// Neither should contain "Native harness" section (pure invoke mode)
			expect(legacy).not.toContain("Native harness");
			expect(legacy).not.toContain("orchestrator with a chat or question UI");
			expect(mixed).not.toContain("Native harness");
			expect(mixed).not.toContain("orchestrator with a chat or question UI");

			// Both should still have invoke delegation patterns
			expect(legacy).toContain("5x invoke");
			expect(mixed).toContain("5x invoke");
		});

		test("mixed-mode quality-retry escalation uses native UI when any role is native", () => {
			// This is a P2 regression test - the quality-retry escalation should use
			// native UI (any_native) not require all roles to be native
			const nativeNative = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(true, true),
			).content;
			const nativeInvoke = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(true, false),
			).content;
			const invokeNative = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(false, true),
			).content;
			const invokeInvoke = renderSkillByName(
				"5x-phase-execution",
				makeMixedContext(false, false),
			).content;

			// When any role is native, the escalation should mention "native UI"
			expect(nativeNative).toContain("Escalate via your **native UI**");
			expect(nativeInvoke).toContain("Escalate via your **native UI**");
			expect(invokeNative).toContain("Escalate via your **native UI**");

			// When no roles are native (invoke/invoke), use CLI prompt
			expect(invokeInvoke).not.toContain("Escalate via your **native UI**");
			expect(invokeInvoke).toContain('5x prompt choose "Quality gates failing');
		});

		test("all four context combinations produce valid output", () => {
			const combinations = [
				{ author: true, reviewer: true, name: "native/native" },
				{ author: false, reviewer: false, name: "invoke/invoke" },
				{ author: true, reviewer: false, name: "native/invoke" },
				{ author: false, reviewer: true, name: "invoke/native" },
			];

			for (const combo of combinations) {
				const ctx = makeMixedContext(combo.author, combo.reviewer);
				for (const name of listBaseSkillNames()) {
					const skill = renderSkillByName(name, ctx);
					expect(skill.content).toBeTruthy();
					expect(skill.content.length).toBeGreaterThan(100);
					// Verify no template directive markers remain
					expect(skill.content).not.toContain("{{#if");
					expect(skill.content).not.toContain("{{else}}");
					expect(skill.content).not.toContain("{{/if}}");
				}
			}
		});
	});
});
