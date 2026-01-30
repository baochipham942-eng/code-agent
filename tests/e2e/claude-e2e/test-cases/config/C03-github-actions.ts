import { TestCase } from '../../src/types.js';

export const C03: TestCase = {
  id: 'C03',
  name: 'GitHub Actions 配置',
  category: 'config',
  complexity: 'L2',

  prompt: `创建 GitHub Actions CI 配置：
1. 在 .github/workflows/ci.yml 创建工作流
2. 在 push 和 pull_request 时触发
3. 使用 Node.js 20
4. 执行 npm install、npm run build、npm test`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: '.github/workflows/ci.yml',
    },
    {
      type: 'file-contains',
      target: '.github/workflows/ci.yml',
      contains: ['push', 'pull_request', 'node', 'npm (install|ci)', 'npm run build', 'npm test'],
      regex: true,
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Write'],
    forbiddenTools: ['Edit'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['config', 'github-actions', 'ci', 'workflow'],
  timeout: 120000,
  retries: 2,
};

export default C03;
