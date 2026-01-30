import { TestCase } from '../../src/types.js';

export const R04: TestCase = {
  id: 'R04',
  name: '拆分文件',
  category: 'refactoring',
  complexity: 'L2',

  prompt: `拆分 users.ts 为三个文件：

1. 读取 src/api/routes/users.ts
2. write_file 创建 src/api/controllers/users.controller.ts（导出函数）
3. write_file 创建 src/api/validators/users.validator.ts（导出验证函数）
4. edit_file 修改 users.ts（保留路由，导入新模块）

必须创建两个新文件！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/controllers/users.controller.ts',
    },
    {
      type: 'file-exists',
      target: 'src/api/validators/users.validator.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['import'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    // 分步执行模式下 trace 收集有限制
    toolCallRange: { min: 0, max: 30 },
  },

  tags: ['refactoring', 'split-file', 'separation-of-concerns'],
  timeout: 300000,

  // 使用步骤分解执行
  stepByStepExecution: true,
  steps: [
    {
      instruction: '读取 src/api/routes/users.ts 文件，分析其中的函数和结构',
    },
    {
      instruction: '使用 write_file 创建 src/api/controllers/users.controller.ts，将控制器函数（getUsers、getUserById、createUser 等）导出',
      validation: {
        type: 'file-exists',
        target: 'src/api/controllers/users.controller.ts',
      },
    },
    {
      instruction: '使用 write_file 创建 src/api/validators/users.validator.ts，导出验证函数（validateUser、validateUserId 等）',
      validation: {
        type: 'file-exists',
        target: 'src/api/validators/users.validator.ts',
      },
    },
    {
      instruction: '使用 edit_file 修改 src/api/routes/users.ts，保留路由定义，添加 import 语句导入新模块',
      validation: {
        type: 'file-contains',
        target: 'src/api/routes/users.ts',
        contains: ['import'],
      },
    },
  ],

  retries: 2,
};

export default R04;
