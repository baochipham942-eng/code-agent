import { TestCase } from '../../src/types.js';

export const D02: TestCase = {
  id: 'D02',
  name: '修复类型错误',
  category: 'debugging',
  complexity: 'L1',

  prompt: 'TypeScript 编译报类型错误，请检查并修复 src/ 目录下的类型问题',

  fixture: 'bug-type-error',

  validations: [
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read'],
    toolCallRange: { min: 2, max: 10 },
  },

  tags: ['debugging', 'type-error', 'typescript'],
  timeout: 180000,
};

export default D02;
