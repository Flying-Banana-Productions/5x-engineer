/**
 * Harness-specific token substitution for shared skill templates.
 *
 * Base skill templates can use semantic placeholders (for example,
 * [[NATIVE_CONTINUE_PARAM]]) so harness loaders can render concrete syntax
 * without baking harness-specific parameter names into shared content.
 */

export const SKILL_TOKENS = {
	NATIVE_CONTINUE_PARAM: "NATIVE_CONTINUE_PARAM",
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
