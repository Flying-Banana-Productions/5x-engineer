export interface SkillRenderContext {
	/** Legacy backward-compatibility: true when both roles are native. */
	native: boolean;
	/** Legacy backward-compatibility: true when both roles are invoke. */
	invoke?: boolean;
	/** Per-role delegation: true = Task tool, false = 5x invoke. */
	authorNative?: boolean;
	reviewerNative?: boolean;
	/** Cross-cutting: true when at least one role uses native delegation. */
	anyNative?: boolean;
	/** Cross-cutting: true when at least one role uses invoke delegation. */
	anyInvoke?: boolean;
}

/**
 * Create a full SkillRenderContext from simple native/invoke flags.
 * This is a backward-compatibility helper for code that hasn't been
 * updated to use per-role delegation flags yet.
 *
 * When native=true: both roles are native (native/native mode)
 * When native=false: both roles are invoke (invoke/invoke mode)
 */
export function createRenderContext(
	native: boolean,
	authorNative?: boolean,
	reviewerNative?: boolean,
): SkillRenderContext {
	// If per-role flags not provided, derive from the legacy native flag
	const author = authorNative ?? native;
	const reviewer = reviewerNative ?? native;
	const anyNative = author || reviewer;
	const anyInvoke = !author || !reviewer;

	return {
		native: author && reviewer,
		invoke: !author && !reviewer,
		authorNative: author,
		reviewerNative: reviewer,
		anyNative,
		anyInvoke,
	};
}

/**
 * Render a skill template by processing conditional blocks.
 *
 * Syntax (each directive must be on its own line, no leading content):
 *   {{#if native}}           — include block when BOTH roles are native (legacy)
 *   {{#if invoke}}           — include block when BOTH roles are invoke (legacy)
 *   {{#if author_native}}    — include block when author uses native delegation
 *   {{#if author_invoke}}    — include block when author uses invoke delegation
 *   {{#if reviewer_native}}  — include block when reviewer uses native delegation
 *   {{#if reviewer_invoke}}  — include block when reviewer uses invoke delegation
 *   {{#if any_native}}       — include block when at least one role is native
 *   {{#if any_invoke}}       — include block when at least one role is invoke
 *   {{else}}                 — switch to the opposite branch
 *   {{/if}}                  — end conditional block
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

	// Derive per-role flags for backward compatibility with legacy { native: boolean } context
	const authorNative = ctx.authorNative ?? ctx.native;
	const reviewerNative = ctx.reviewerNative ?? ctx.native;
	const anyNative = ctx.anyNative ?? (authorNative || reviewerNative);
	const anyInvoke = ctx.anyInvoke ?? (!authorNative || !reviewerNative);
	const invoke = ctx.invoke ?? !ctx.native;

	for (const line of lines) {
		// Handle all {{#if ...}} directives
		const ifMatch = line.match(/^\{\{#if\s+(\w+)\}\}$/);
		if (ifMatch) {
			if (inBlock) {
				throw new Error("Nested {{#if}} blocks are not supported");
			}
			inBlock = true;
			seenElse = false;

			const directive = ifMatch[1];
			switch (directive) {
				// Legacy directives (both roles must match)
				case "native":
					blockActive = ctx.native;
					break;
				case "invoke":
					blockActive = invoke;
					break;
				// Per-role directives
				case "author_native":
					blockActive = authorNative;
					break;
				case "author_invoke":
					blockActive = !authorNative;
					break;
				case "reviewer_native":
					blockActive = reviewerNative;
					break;
				case "reviewer_invoke":
					blockActive = !reviewerNative;
					break;
				// Cross-cutting directives
				case "any_native":
					blockActive = anyNative;
					break;
				case "any_invoke":
					blockActive = anyInvoke;
					break;
				default:
					throw new Error(`Unknown directive: {{#if ${directive}}}`);
			}
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
