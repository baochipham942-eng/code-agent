// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { skillCreateTool } from '../../skill/skillCreateTool';

export const skillCreateSchema: ToolSchema = {
  name: 'SkillCreate',
  description: skillCreateTool.description,
  inputSchema: skillCreateTool.inputSchema,
  category: 'skill',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
