/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    adapter: 'claude-code',
    model: 'sonnet'
  },
  reviewer: {
    adapter: 'claude-code',
    model: 'opus'
  },
  qualityGates: [
    // Add your test/lint/build commands here, e.g.:
    // 'bun test',
    // 'bun run lint',
    // 'bun run build',
    'bun test --concurrent --dots'
  ],
};
