import { TestCase } from '../../src/types.js';

export const V03: TestCase = {
  id: 'V03',
  name: '功能分支管理',
  category: 'git',
  complexity: 'L2',

  prompt: `执行以下 Git 操作：
1. 创建并切换到新分支 feature/add-logout
2. 在 src/index.ts 中添加一个 logout 函数
3. 暂存并提交改动，使用规范的 commit message
4. 列出所有分支确认创建成功`,

  fixture: 'typescript-basic',

  setupCommands: [
    'git init',
    'git config user.email "test@example.com"',
    'git config user.name "Test User"',
    'git add .',
    'git commit -m "init"',
  ],

  validations: [
    {
      type: 'output-contains',
      contains: ['feature/add-logout'],
    },
    {
      type: 'file-contains',
      target: 'src/index.ts',
      contains: ['logout'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Bash', 'Edit'],
    toolCallRange: { min: 3, max: 10 },
  },

  tags: ['git', 'branch', 'feature-branch', 'workflow'],
  timeout: 150000,
  retries: 2,
};

export default V03;
