import { TestCase } from '../../src/types.js';

export const T02: TestCase = {
  id: 'T02',
  name: '编写单元测试',
  category: 'documentation',
  complexity: 'L1',

  prompt:
    '为 src/index.ts 中的 hello 函数编写单元测试，保存到 src/index.test.ts，使用 vitest 框架',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/index.test.ts',
    },
    {
      type: 'file-contains',
      target: 'src/index.test.ts',
      contains: ['hello', 'expect'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['documentation', 'testing', 'vitest'],
  timeout: 180000,
  nudgeOnMissingFile: true,  // 文件未创建时提示模型完成
};

export default T02;
