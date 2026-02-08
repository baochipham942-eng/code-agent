import { TestCase } from '../../src/types.js';

/**
 * T3-A: 软件开发协作 (ChatDev/MetaGPT 风格)
 * 测试多 Agent 角色分工：architect → coder → tester → documenter
 */
export const CD03: TestCase = {
  id: 'CD-03',
  name: '文件同步工具',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `开发一个文件目录同步工具，能够检测两个目录的差异并进行同步。

功能需求：
1. 对比两个目录，找出差异（新增、删除、修改的文件）
2. 支持单向同步（source → target）
3. 支持双向同步（合并两边的变更）
4. 支持冲突检测和处理策略
5. 支持排除模式（如 .git, node_modules）

技术要求：
1. TypeScript 编写
2. 使用文件哈希比较内容
3. 提供 CLI 和 API 两种使用方式
4. 包含测试

需要创建的文件：
- src/sync/index.ts - 主入口
- src/sync/differ.ts - 差异比较
- src/sync/syncer.ts - 同步执行
- src/sync/hasher.ts - 文件哈希
- src/sync/types.ts - 类型定义
- src/sync/cli.ts - CLI 入口`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sync/index.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sync/differ.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sync/syncer.ts',
    },
    {
      type: 'file-contains',
      target: 'src/sync/differ.ts',
      containsAny: ['compare', 'diff', 'added', 'removed', 'modified'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/sync/hasher.ts',
      containsAny: ['hash', 'md5', 'sha', 'crypto'],
      ignoreCase: true,
    },
  ],

  processValidations: [
    {
      type: 'agent-dispatched',
      message: '应调度子 Agent 完成复杂任务',
    },
    {
      type: 'tool-count-min',
      count: 5,
      message: '至少需要 5 次工具调用',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['coder', 'architect', 'tester'],
    toolCallRange: { min: 5, max: 25 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'cli', 'filesystem'],
  timeout: 360000,
  stepByStepExecution: true,
  steps: [
    {
      instruction: '创建类型定义 src/sync/types.ts',
      validation: { type: 'file-exists', target: 'src/sync/types.ts' },
    },
    {
      instruction: '创建哈希工具 src/sync/hasher.ts',
      validation: { type: 'file-exists', target: 'src/sync/hasher.ts' },
    },
    {
      instruction: '创建差异比较模块 src/sync/differ.ts',
      validation: { type: 'file-exists', target: 'src/sync/differ.ts' },
    },
    {
      instruction: '创建同步执行模块 src/sync/syncer.ts',
      validation: { type: 'file-exists', target: 'src/sync/syncer.ts' },
    },
    {
      instruction: '创建主入口 src/sync/index.ts',
      validation: { type: 'file-exists', target: 'src/sync/index.ts' },
    },
  ],
  nudgeOnMissingFile: true,
};

export default CD03;
