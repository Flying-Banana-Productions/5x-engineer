export interface SkillRenderContext {
	/** true = native harness delegation (Task tool, subagents), false = CLI invoke delegation (5x invoke) */
	native: boolean;
}

/**
 * Render a skill template by processing conditional blocks.
 *
 * Syntax (each directive must be on its own line, no leading content):
 *   {{#if native}}   — include block when ctx.native is true
 *   {{#if invoke}}   — include block when ctx.native is false
 *   {{else}}         — switch to the opposite branch
 *   {{/if}}          — end conditional block
 *
 * Directive lines are stripped from output. Content lines are
 * included/excluded based on the active condition.
 * Nesting is not supported.
 */
export function renderSkillTemplate(
	template: string,
	ctx: SkillRenderContext,
): string {
	const lines = template.split(/\r?\n/);
	const output: string[] = [];

	let inBlock = false;
	let blockActive = false;
	let seenElse = false;

	for (const line of lines) {
		if (line === "{{#if native}}" || line === "{{#if invoke}}") {
			if (inBlock) {
				throw new Error("Nested {{#if}} blocks are not supported");
			}
			inBlock = true;
			seenElse = false;
			blockActive = line === "{{#if native}}" ? ctx.native : !ctx.native;
			continue;
		}

		if (line === "{{else}}") {
			if (!inBlock) {
				throw new Error("Unmatched {{else}} directive");
			}
			if (seenElse) {
				throw new Error("Duplicate {{else}} directive in conditional block");
			}
			seenElse = true;
			blockActive = !blockActive;
			continue;
		}

		if (line === "{{/if}}") {
			if (!inBlock) {
				throw new Error("Unmatched {{/if}} directive");
			}
			inBlock = false;
			blockActive = false;
			seenElse = false;
			continue;
		}

		if (!inBlock || blockActive) {
			output.push(line);
		}
	}

	if (inBlock) {
		throw new Error("Unclosed {{#if}} block");
	}

	return output.join("\n");
}
