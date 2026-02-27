/** @type {import('5x-cli').FiveXConfig} */
export default {
	// OpenCode server runs locally (same host). Remote server support is a future feature.
	// Configure model/timeouts independently for author and reviewer invocations.
	author: {
		model: "anthropic/claude-opus-4-6",
    // model: "openai/gpt-5.3-codex",
		// timeout: 900, // seconds; omit to disable timeout
	},
	reviewer: {
    model: "opencode/gpt-5.2",
		// model: "openai/gpt-5.2",
		// timeout: 900, // seconds; omit to disable timeout
	},

	// Commands run after author implementation and before reviewer pass.
	// Any failing command triggers quality-retry behavior.
	qualityGates: [
		// "bun test",
		// "bun run lint",
		// "bun run build",
	],

	// Optional hook for `5x run --worktree` after a new worktree is created.
	worktree: {
		// postCreate: "bun install",
	},

	// Paths are relative to repository root unless absolute.
	paths: {
		plans: "docs/development",
		reviews: "docs/development/reviews",
		// planReviews: "docs/development/reviews/plans",  // plan review output dir (defaults to reviews)
		// runReviews: "docs/development/reviews/impl",    // implementation review output dir (defaults to reviews)
		archive: "docs/archive",
		templates: {
			plan: ".5x/templates/implementation-plan-template.md",
			review: ".5x/templates/review-template.md",
		},
	},

	// SQLite database location for run history and state.
	db: {
		path: ".5x/5x.db",
	},

	// Loop guardrails and retry limits.
	maxReviewIterations: 5,
	maxQualityRetries: 3,
	maxAutoIterations: 10,
	maxAutoRetries: 3,
};
