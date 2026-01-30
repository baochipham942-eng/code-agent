import { TestCase } from '../../src/types.js';

export const M01: TestCase = {
  id: 'M01',
  name: '添加字段（多文件）',
  category: 'multi-file',
  complexity: 'L2',

  prompt: `为 User 添加 avatar 字段，修改以下4个文件：

1. prisma/schema.prisma - 添加 avatar String?
2. src/api/services/user.service.ts - User 接口添加 avatar?: string
3. src/api/routes/users.ts - createUser 参数添加 avatar
4. src/components/UserList.tsx - 显示 user.avatar

每个文件都要先 read_file 再 edit_file 修改！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['avatar'],
    },
    {
      type: 'file-contains',
      target: 'src/api/services/user.service.ts',
      contains: ['avatar'],
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['avatar'],
    },
    {
      type: 'file-contains',
      target: 'src/components/UserList.tsx',
      contains: ['avatar'],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    forbiddenTools: ['Write'],
    toolCallRange: { min: 5, max: 15 },
  },

  tags: ['multi-file', 'refactoring', 'schema-change', 'fullstack'],
  timeout: 300000,
  retries: 4,
};

export default M01;
