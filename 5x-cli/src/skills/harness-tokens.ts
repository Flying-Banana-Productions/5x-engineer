/**
 * Harness-specific token substitution for shared skill templates.
 *
 * Base skill templates can use semantic placeholders (for example,
 * [[NATIVE_CONTINUE_PARAM]]) so harness loaders can render concrete syntax
 * without baking harness-specific parameter names into shared content.
 */

export const SKILL_TOKENS = {
	/** Native continuation parameter on the delegation tool. */
	NATIVE_CONTINUE_PARAM: "NATIVE_CONTINUE_PARAM",
	/** Human-readable name of the native delegation tool. */
	NATIVE_DELEGATE_TOOL: "NATIVE_DELEGATE_TOOL",
	/** Delegation tool parameter that selects the subagent. */
	NATIVE_AGENT_PARAM: "NATIVE_AGENT_PARAM",
	/** Variable that receives the native delegation tool's return value. */
	NATIVE_LAUNCH_VAR: "NATIVE_LAUNCH_VAR",
	/**
	 * Appended after a native launch pseudo-call. Harnesses whose delegation
	 * returns only a launch acknowledgment use it to wait for the child's
	 * completion report and set RESULT from it (may span several lines).
	 */
	NATIVE_AWAIT_RESULT: "NATIVE_AWAIT_RESULT",
	/** Value assigned to $NATIVE_SUBTASK_ID at a continuation capture site. */
	NATIVE_CHILD_ID_SOURCE: "NATIVE_CHILD_ID_SOURCE",
	/** Noun for the captured continuation id in capture comments. */
	NATIVE_CHILD_ID_NOUN: "NATIVE_CHILD_ID_NOUN",
	/** Prose source of the continuation id ("from <value> result"). */
	NATIVE_CHILD_ID_FROM: "NATIVE_CHILD_ID_FROM",
	/** Optional sentence(s) about awaiting the child's completion report. */
	NATIVE_AWAIT_NOTE: "NATIVE_AWAIT_NOTE",
} as const;

export type SkillTokenName = (typeof SKILL_TOKENS)[keyof typeof SKILL_TOKENS];

export type SkillTokenMap = Record<SkillTokenName, string>;

const TOKEN_PATTERN = /\[\[([A-Z0-9_]+)\]\]/g;

export function resolveSkillTokens(
	content: string,
	tokens: SkillTokenMap,
): string {
	return content.replace(TOKEN_PATTERN, (_match, tokenName: string) => {
		const token = tokenName as SkillTokenName;
		const value = tokens[token];
		if (value === undefined) {
			throw new Error(`Missing skill token mapping for [[${tokenName}]]`);
		}
		return value;
	});
}

export function hasUnresolvedSkillTokens(content: string): boolean {
	return /\[\[[A-Z0-9_]+\]\]/.test(content);
}
