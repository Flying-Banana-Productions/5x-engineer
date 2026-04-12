/**
 * Normalize 5x model identifiers for the Claude Code CLI.
 *
 * 5x uses `anthropic/<model>`; Claude Code expects bare model ids or aliases.
 */
export function parseModelForClaudeCode(model: string): string {
	if (model.startsWith("anthropic/")) {
		return model.slice("anthropic/".length);
	}
	return model;
}
