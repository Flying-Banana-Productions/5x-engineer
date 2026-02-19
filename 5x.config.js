/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    model: 'anthropic/claude-opus-4-6'
  },
  reviewer: {
    model: 'openai/gpt-5.2'
  },
  qualityGates: [
    // Add your test/lint/build commands here, e.g.:
    // 'bun test',
    // 'bun run lint',
    // 'bun run build',
    'bun test --concurrent --dots'
  ],
};
