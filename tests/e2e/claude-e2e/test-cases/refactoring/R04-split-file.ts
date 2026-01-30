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
    requiredTools: ['Read', 'Edit', 'Write'],
    toolCallRange: { min: 4, max: 12 },
  },

  tags: ['refactoring', 'split-file', 'separation-of-concerns'],
  timeout: 300000,
  nudgeOnMissingFile: true,
  retries: 4,
};

export default R04;
