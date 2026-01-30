import { TestCase } from '../../src/types.js';

export const D01: TestCase = {
  id: 'D01',
  name: '修复语法错误',
  category: 'debugging',
  complexity: 'L1',

  prompt: 'src/utils/helper.ts 有语法错误导致无法编译，请修复它',

  fixture: 'bug-syntax-error',

  validations: [
    {
      type: 'compile-pass',
    },
    {
      type: 'file-exists',
      target: 'src/utils/helper.ts',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    forbiddenTools: ['Write'],
    toolCallRange: { min: 2, max: 6 },
    toolPattern: 'Read.*Edit',
  },

  tags: ['debugging', 'syntax-error', 'typescript'],
  timeout: 180000,
  retries: 1,  // 模型行为随机性，允许重试一次
};

export default D01;
