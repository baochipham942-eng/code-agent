import { TestCase } from '../../src/types.js';

export const U02: TestCase = {
  id: 'U02',
  name: '复杂度分析',
  category: 'understanding',
  complexity: 'L1',

  prompt: '分析 src/index.ts 中函数的时间复杂度和空间复杂度',

  fixture: 'typescript-basic',

  validations: [],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read'],
    forbiddenTools: ['Write', 'Edit'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['understanding', 'complexity', 'analysis'],
  timeout: 60000,
};

export default U02;
