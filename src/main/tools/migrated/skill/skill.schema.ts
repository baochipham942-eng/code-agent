// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { skillMetaTool, getSkillToolDescription } from '../../skill/skillMetaTool';

export const skillSchema: ToolSchema = {
  name: 'Skill',
  description: skillMetaTool.description,
  // dynamicDescription: 透传 legacy 的动态描述生成器
  dynamicDescription: getSkillToolDescription,
  inputSchema: skillMetaTool.inputSchema,
  category: 'skill',
  permissionLevel: 'read',
  readOnly: false, // skill 可能触发 fork 副作用
  allowInPlanMode: false,
};
