/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    model: 'opencode/kimi-k2.5',
    timeout: 120, // 2 min
  },
  reviewer: {
    model: 'openai/gpt-5.2',
    timeout: 120, // 2 min
  },
  qualityGates: [
    // Add your test/lint/build commands here, e.g.:
    // 'bun test',
    // 'bun run lint',
    // 'bun run build',
    'bun test --concurrent --dots'
  ],
};
