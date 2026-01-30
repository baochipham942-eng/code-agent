import { TestCase } from '../../src/types.js';

export const U01: TestCase = {
  id: 'U01',
  name: '解释函数实现',
  category: 'understanding',
  complexity: 'L1',

  prompt: '解释 src/index.ts 中的代码是做什么的，它的主要功能是什么？',

  fixture: 'typescript-basic',

  validations: [],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read'],
    forbiddenTools: ['Write', 'Edit'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['understanding', 'explanation', 'code-review'],
  timeout: 60000,
};

export default U01;
