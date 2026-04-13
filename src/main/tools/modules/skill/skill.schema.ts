// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time, so it can be
// eager-imported by modules/index.ts without inflating the dependency graph.
//
// 注：legacy skillMetaTool 的 `dynamicDescription` 是通过 `getSkillDiscoveryService`
// 枚举所有 skill 实时生成的；该函数依赖整个 services/skills barrel，
// 不能在 schema 模块顶层 eager import。需要动态描述时由 dispatch 层另行查询。
import type { ToolSchema } from '../../../protocol/tools';

export const SKILL_DESCRIPTION = '执行已注册的 skill';

export const SKILL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      type: 'string',
      description: 'The skill name to execute (e.g., "commit", "code-review")',
    },
    args: {
      type: 'string',
      description: 'Optional arguments or context for the skill',
    },
  },
  required: ['command'],
};

export const skillSchema: ToolSchema = {
  name: 'Skill',
  description: SKILL_DESCRIPTION,
  inputSchema: SKILL_INPUT_SCHEMA,
  category: 'skill',
  permissionLevel: 'read',
  readOnly: false, // skill 可能触发 fork 副作用
  allowInPlanMode: false,
};
