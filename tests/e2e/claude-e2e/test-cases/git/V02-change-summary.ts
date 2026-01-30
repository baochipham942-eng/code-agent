import { TestCase } from '../../src/types.js';

export const V02: TestCase = {
  id: 'V02',
  name: '总结改动',
  category: 'git',
  complexity: 'L1',

  prompt: '查看 git log，总结最近的代码改动',

  fixture: 'typescript-basic',

  setupCommands: [],

  validations: [],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['git', 'log', 'summary'],
  timeout: 120000,
};

export default V02;
