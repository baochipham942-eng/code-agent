// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time, so it can be
// eager-imported by modules/index.ts without inflating the dependency graph.
import type { ToolSchema } from '../../../protocol/tools';

export const SKILL_CREATE_DESCRIPTION =
  '创建新的可复用 skill。完成复杂多步任务后，如果工作流可复用，调用此工具创建 SKILL.md。用户会在创建前确认。';

export const SKILL_CREATE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string',
      description: 'Skill 名称（小写字母+数字+连字符，如 "deploy-vercel"）',
    },
    description: {
      type: 'string',
      description: 'Skill 用途描述（说明做什么、何时触发，≤1024 字符）',
    },
    content: {
      type: 'string',
      description: 'SKILL.md 的 markdown body（不含 frontmatter）',
    },
    scope: {
      type: 'string',
      description: '保存范围："user"（用户级，默认）或 "project"（项目级）',
    },
    allowedTools: {
      type: 'string',
      description: '允许使用的工具列表，空格分隔（可选）',
    },
  },
  required: ['name', 'description', 'content'],
};

export const skillCreateSchema: ToolSchema = {
  name: 'SkillCreate',
  description: SKILL_CREATE_DESCRIPTION,
  inputSchema: SKILL_CREATE_INPUT_SCHEMA,
  category: 'skill',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
