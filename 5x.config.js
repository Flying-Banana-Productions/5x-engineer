/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    model: 'anthropic/claude-opus-4-6',
    timeout: 1_800_000, // 30 min
  },
  reviewer: {
    model: 'openai/gpt-5.2',
    timeout: 900_000, // 15 min
  },
  qualityGates: [
    // Add your test/lint/build commands here, e.g.:
    // 'bun test',
    // 'bun run lint',
    // 'bun run build',
    'bun test --concurrent --dots'
  ],
};
