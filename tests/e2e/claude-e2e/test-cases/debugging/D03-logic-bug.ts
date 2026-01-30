import { TestCase } from '../../src/types.js';

export const D03: TestCase = {
  id: 'D03',
  name: '修复逻辑 bug',
  category: 'debugging',
  complexity: 'L2',

  prompt: `src/utils/array.ts 中的 unique 函数有问题，对于对象数组返回结果不正确。
预期: unique([{id:1}, {id:1}], 'id') 应返回 [{id:1}]
实际: 返回了 [{id:1}, {id:1}]
请修复这个问题。`,

  fixture: 'bug-logic-array',

  validations: [
    {
      type: 'compile-pass',
    },
    {
      type: 'test-pass',
      target: 'src/utils/array.test.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/array.ts',
      notContains: ['// TODO', '// FIXME'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    forbiddenTools: ['Write'],
    toolCallRange: { min: 2, max: 8 },
    toolPattern: 'Read.*Edit',
  },

  tags: ['debugging', 'logic-bug', 'array'],
  timeout: 90000,
  retries: 1,
};

export default D03;
