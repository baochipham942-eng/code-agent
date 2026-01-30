import { TestCase } from '../../src/types.js';

export const C05: TestCase = {
  id: 'C05',
  name: 'Monorepo 配置',
  category: 'config',
  complexity: 'L3',

  prompt: `将项目转换为 pnpm workspace monorepo 结构。

目标结构：
packages/
  shared/         - 共享工具和类型
  api/            - 后端 API
  web/            - 前端应用

需要：
1. 创建 pnpm-workspace.yaml
2. 在根目录创建 package.json（workspace 配置）
3. 创建各包的 package.json
4. 配置 TypeScript project references
5. 将现有代码按职责分配到各包

确保：
- 包之间可以正确引用
- 类型定义正确共享
- 根目录的 build/test 脚本能运行所有包`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'pnpm-workspace.yaml',
    },
    {
      type: 'file-contains',
      target: 'pnpm-workspace.yaml',
      contains: ['packages/*'],
    },
    {
      type: 'file-exists',
      target: 'packages/shared/package.json',
    },
    {
      type: 'file-exists',
      target: 'packages/api/package.json',
    },
    {
      type: 'file-exists',
      target: 'packages/web/package.json',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Bash', 'Glob'],
    toolCallRange: { min: 8, max: 25 },
  },

  tags: ['config', 'monorepo', 'pnpm', 'workspace'],
  timeout: 180000,
};

export default C05;
