import { TestCase } from '../../src/types.js';

export const V06: TestCase = {
  id: 'V06',
  name: '代码审查',
  category: 'git',
  complexity: 'L4',

  prompt: `对当前分支相对于 main 分支的所有改动进行代码审查。

审查维度：
1. 代码质量
   - 命名是否清晰
   - 函数是否过长
   - 是否有重复代码

2. 潜在问题
   - 边界条件处理
   - 错误处理
   - 类型安全

3. 性能考量
   - 是否有性能隐患
   - 数据结构选择

4. 安全性
   - 输入验证
   - 敏感数据处理

5. 可维护性
   - 代码组织
   - 注释和文档

生成详细的审查报告到 CODE_REVIEW.md，包括：
- 发现的问题及位置
- 改进建议
- 优点肯定`,

  fixture: 'typescript-basic',

  setupCommands: [
    // createTempProject 已完成 git init 和初始提交
    'git checkout -b feature/complex-change',
    'mkdir -p src/utils',
    'printf "export function processData(data: any) { return data.map((x: any) => x * 2); }\\n" > src/utils/process.ts',
    'git add .',
    'git commit -m "feat: add data processing"',
  ],

  validations: [
    {
      type: 'file-exists',
      target: 'CODE_REVIEW.md',
    },
    {
      type: 'file-contains',
      target: 'CODE_REVIEW.md',
      contains: ['##', 'any', '建议'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['code-review'], // explore 是可选的，code-review 是核心
    requiredTools: ['Bash', 'Read', 'Write'],
    toolCallRange: { min: 5, max: 30 },
  },

  tags: ['git', 'code-review', 'quality', 'analysis'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default V06;
