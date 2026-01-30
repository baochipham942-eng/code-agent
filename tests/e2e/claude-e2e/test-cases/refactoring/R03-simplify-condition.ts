import { TestCase } from '../../src/types.js';

export const R03: TestCase = {
  id: 'R03',
  name: '简化条件',
  category: 'refactoring',
  complexity: 'L2',

  prompt: `**任务：重构 src/api/middleware/auth.ts**

步骤：
1. 读取 src/api/middleware/auth.ts
2. **立即使用 edit_file 修改它**

重构要求：
- 使用 early return 减少嵌套
- 提取复杂条件为变量
- 确保逻辑行为不变

⚠️ 重要：读取文件后必须调用 edit_file 执行修改！不能只分析不修改。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/middleware/auth.ts',
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    toolCallRange: { min: 2, max: 8 },
  },

  tags: ['refactoring', 'simplify', 'conditions', 'clean-code'],
  timeout: 150000,
  retries: 2,
};

export default R03;
