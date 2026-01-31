import { TestCase } from '../../src/types.js';

export const M01: TestCase = {
  id: 'M01',
  name: '添加字段（多文件）',
  category: 'multi-file',
  complexity: 'L2',

  prompt: `为 User 添加 avatar 字段。

⚠️ 必须修改以下 5 个文件，每个都要完成：

□ 1. prisma/schema.prisma - 在 User model 中添加 avatar String?
□ 2. src/api/services/user.service.ts - User 接口添加 avatar?: string
□ 3. src/store/user.store.ts - User 接口添加 avatar?: string
□ 4. src/api/routes/users.ts - createUser 参数添加 avatar
□ 5. src/components/UserList.tsx - 显示 user.avatar

执行步骤：先用 read_file 读取文件，再用 edit_file 修改。
确保所有 5 个文件都修改完成后再停止！`,

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
      target: 'src/store/user.store.ts',
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
    // 分步执行模式下 trace 收集有限制，暂时放宽 tool 验证
    // requiredTools: ['Read', 'Edit'],
    // forbiddenTools: ['Write'],
    toolCallRange: { min: 0, max: 50 },
  },

  tags: ['multi-file', 'refactoring', 'schema-change', 'fullstack'],
  timeout: 300000,

  // 关闭分步执行，使用单次调用 + 清单式 prompt
  // stepByStepExecution: true,
  retries: 3,
  nudgeOnMissingFile: true,
  _disabledSteps: [
    {
      instruction: '读取 prisma/schema.prisma 文件',
    },
    {
      instruction: '使用 edit_file 修改 prisma/schema.prisma，在 User model 中添加 avatar String? 字段',
      validation: {
        type: 'file-contains',
        target: 'prisma/schema.prisma',
        contains: ['avatar'],
      },
    },
    {
      instruction: '读取 src/api/services/user.service.ts 文件',
    },
    {
      instruction: '使用 edit_file 修改 src/api/services/user.service.ts，在 User 接口中添加 avatar?: string 字段',
      validation: {
        type: 'file-contains',
        target: 'src/api/services/user.service.ts',
        contains: ['avatar'],
      },
    },
    {
      instruction: '读取 src/store/user.store.ts 文件',
    },
    {
      instruction: '使用 edit_file 修改 src/store/user.store.ts，在 User 接口中添加 avatar?: string 字段',
      validation: {
        type: 'file-contains',
        target: 'src/store/user.store.ts',
        contains: ['avatar'],
      },
    },
    {
      instruction: '读取 src/api/routes/users.ts 文件',
    },
    {
      instruction: '使用 edit_file 修改 src/api/routes/users.ts，在 createUser 函数参数中添加 avatar',
      validation: {
        type: 'file-contains',
        target: 'src/api/routes/users.ts',
        contains: ['avatar'],
      },
    },
    {
      instruction: '读取 src/components/UserList.tsx 文件',
    },
    {
      instruction: '使用 edit_file 修改 src/components/UserList.tsx，显示 user.avatar（例如添加 <img> 或 <span> 元素）',
      validation: {
        type: 'file-contains',
        target: 'src/components/UserList.tsx',
        contains: ['avatar'],
      },
    },
  ],

  retries: 2,
};

export default M01;
