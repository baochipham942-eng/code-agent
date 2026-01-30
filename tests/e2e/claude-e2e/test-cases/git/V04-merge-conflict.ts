import { TestCase } from '../../src/types.js';

export const V04: TestCase = {
  id: 'V04',
  name: '合并冲突解决',
  category: 'git',
  complexity: 'L2',

  prompt: `当前仓库有一个合并冲突需要解决：
1. 查看冲突文件和冲突内容
2. 分析两边的改动意图
3. 合理解决冲突（保留两边的功能）
4. 完成合并提交`,

  fixture: 'typescript-basic',

  setupCommands: [
    'git init',
    'git add .',
    'git commit -m "init"',
    'git checkout -b feature-a',
    'echo "export const FEATURE_A = true;" >> src/index.ts',
    'git add . && git commit -m "feat: add feature A"',
    'git checkout main',
    'git checkout -b feature-b',
    'echo "export const FEATURE_B = true;" >> src/index.ts',
    'git add . && git commit -m "feat: add feature B"',
    'git checkout main',
    'git merge feature-a -m "merge feature-a"',
    'git merge feature-b || true',
  ],

  validations: [
    {
      type: 'file-contains',
      target: 'src/index.ts',
      contains: ['FEATURE_A', 'FEATURE_B'],
      notContains: ['<<<<<<<', '>>>>>>>', '======='],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Bash', 'Read', 'Edit'],
    toolCallRange: { min: 3, max: 12 },
  },

  tags: ['git', 'merge', 'conflict', 'resolution'],
  timeout: 150000,
};

export default V04;
