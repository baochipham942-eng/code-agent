import { TestCase } from '../../src/types.js';

export const T03: TestCase = {
  id: 'T03',
  name: 'API 文档生成',
  category: 'documentation',
  complexity: 'L2',

  prompt: `为 users.ts 添加 JSDoc 文档。

1. 读取 src/api/routes/users.ts
2. 用 edit_file 为每个函数添加 JSDoc 注释（包含 @param、@returns）
3. 用 write_file 创建 src/api/routes/README.md 概述 API 端点

必须执行 edit_file 修改 users.ts！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['/**', '@param', '@returns', '@example'],
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/README.md',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/README.md',
      contains: ['getUsers', 'getUserById', 'createUser'],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit', 'Write'],
    toolCallRange: { min: 3, max: 8 },
  },

  tags: ['documentation', 'api-doc', 'jsdoc', 'readme'],
  timeout: 180000,
  nudgeOnMissingFile: true,
  retries: 4,
};

export default T03;
