import { TestCase } from '../../src/types.js';

export const R03: TestCase = {
  id: 'R03',
  name: '简化条件',
  category: 'refactoring',
  complexity: 'L2',

  prompt: `**任务：重构 src/api/middleware/auth.ts**

步骤：
1. 读取 src/api/middleware/auth.ts
2. **必须使用 edit_file 执行以下改进**

必须完成的修改：
- 将 token 验证逻辑提取为独立函数 parseToken 或 validateToken
- 添加类型守卫或更明确的错误处理
- 保持原有功能不变

示例改进方向：
\`\`\`typescript
function parseToken(token: string): number | null {
  // 提取的验证逻辑
}
\`\`\`

⚠️ 必须调用 edit_file 修改文件，不能只分析！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/middleware/auth.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/middleware/auth.ts',
      // 验证有提取函数或改进（原文件只有 authenticate 函数）
      containsAny: ['parseToken', 'validateToken', 'isValid', 'function', 'const parse', 'const validate'],
      ignoreCase: true,
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
