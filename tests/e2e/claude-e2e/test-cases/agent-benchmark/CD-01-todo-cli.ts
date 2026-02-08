import { TestCase } from '../../src/types.js';

/**
 * T3-A: 软件开发协作 (ChatDev/MetaGPT 风格)
 * 测试多 Agent 角色分工：architect → coder → tester
 */
export const CD01: TestCase = {
  id: 'CD-01',
  name: '命令行待办事项工具',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `开发一个命令行待办事项管理工具。

功能需求：
1. 添加任务：todo add "任务内容"
2. 列出任务：todo list [--all | --done | --pending]
3. 完成任务：todo done <id>
4. 删除任务：todo delete <id>

技术要求：
1. 使用 TypeScript 编写
2. 数据存储在本地 JSON 文件 (~/.todo.json)
3. 包含单元测试

需要创建的文件：
- src/cli/todo.ts - 主入口
- src/cli/commands/add.ts - 添加命令
- src/cli/commands/list.ts - 列表命令
- src/cli/commands/done.ts - 完成命令
- src/cli/commands/delete.ts - 删除命令
- src/cli/storage.ts - 数据存储
- src/cli/types.ts - 类型定义
- src/cli/__tests__/todo.test.ts - 测试文件`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/cli/todo.ts',
    },
    {
      type: 'file-exists',
      target: 'src/cli/commands/add.ts',
    },
    {
      type: 'file-exists',
      target: 'src/cli/storage.ts',
    },
    {
      type: 'file-contains',
      target: 'src/cli/todo.ts',
      contains: ['add', 'list', 'done', 'delete'],
    },
    {
      type: 'file-contains',
      target: 'src/cli/storage.ts',
      contains: ['JSON', 'read', 'write'],
      ignoreCase: true,
    },
  ],

  processValidations: [
    {
      type: 'agent-dispatched',
      message: '应调度子 Agent 完成任务',
    },
    {
      type: 'tool-count-min',
      count: 5,
      message: '至少需要 5 次工具调用创建多个文件',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['coder', 'architect'],
    toolCallRange: { min: 5, max: 20 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'cli', 'collaboration'],
  timeout: 300000,
  stepByStepExecution: true,
  steps: [
    {
      instruction: '创建类型定义文件 src/cli/types.ts',
      validation: { type: 'file-exists', target: 'src/cli/types.ts' },
    },
    {
      instruction: '创建数据存储模块 src/cli/storage.ts',
      validation: { type: 'file-exists', target: 'src/cli/storage.ts' },
    },
    {
      instruction: '创建添加命令 src/cli/commands/add.ts',
      validation: { type: 'file-exists', target: 'src/cli/commands/add.ts' },
    },
    {
      instruction: '创建列表命令 src/cli/commands/list.ts',
      validation: { type: 'file-exists', target: 'src/cli/commands/list.ts' },
    },
    {
      instruction: '创建主入口 src/cli/todo.ts',
      validation: { type: 'file-exists', target: 'src/cli/todo.ts' },
    },
  ],
  nudgeOnMissingFile: true,
};

export default CD01;
