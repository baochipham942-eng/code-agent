// ============================================================================
// SkillCreate Tool — Agent-Initiated Skill Creation
//
// 让 agent 在完成复杂任务后自主创建可复用 skill。
// requiresPermission: true → 用户确认弹窗兜底。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getSkillDiscoveryService } from '../../services/skills';
import { getSkillsDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';
import {
  SKILL_CREATE_DESCRIPTION,
  SKILL_CREATE_INPUT_SCHEMA,
} from '../migrated/skill/skillCreate.schema';

const logger = createLogger('SkillCreateTool');

const SKILL_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

function validateName(name: string): string | null {
  if (name.length < 1 || name.length > 64) {
    return `名称长度必须 1-64 字符（当前 ${name.length}）`;
  }
  if (!SKILL_NAME_REGEX.test(name)) {
    return '名称只能包含小写字母、数字和连字符，且以小写字母开头';
  }
  return null;
}

function buildSkillMd(params: {
  name: string;
  description: string;
  content: string;
  allowedTools?: string;
}): string {
  const now = new Date().toISOString();
  const lines = [
    '---',
    `name: ${params.name}`,
    `description: "${params.description.replace(/"/g, '\\"')}"`,
    'user-invocable: true',
    'context: inline',
  ];

  if (params.allowedTools) {
    lines.push(`allowed-tools: "${params.allowedTools}"`);
  }

  lines.push(
    'metadata:',
    '  auto-created: "true"',
    `  created-at: "${now}"`,
    '  created-by: "agent"',
    '---',
    '',
    params.content,
  );

  return lines.join('\n');
}

export const skillCreateTool: Tool = {
  name: 'SkillCreate',
  description: SKILL_CREATE_DESCRIPTION,
  requiresPermission: true,
  permissionLevel: 'write',
  tags: ['evolution'],
  inputSchema: SKILL_CREATE_INPUT_SCHEMA,

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const name = (params.name as string).trim();
    const description = (params.description as string).trim();
    const content = params.content as string;
    const scope = (params.scope as string | undefined)?.trim() || 'user';
    const allowedTools = params.allowedTools as string | undefined;

    // 1. 名称验证
    const nameError = validateName(name);
    if (nameError) {
      return { success: false, error: `名称无效: ${nameError}` };
    }

    // 2. 描述长度验证
    if (description.length > 1024) {
      return { success: false, error: `描述超长: ${description.length}/1024` };
    }

    // 3. 去重检查
    const discoveryService = getSkillDiscoveryService();
    try {
      await discoveryService.ensureInitialized(
        context.workingDirectory || process.cwd(),
      );
    } catch {
      // 初始化失败不阻塞，继续去重检查
    }

    const existing = discoveryService.getSkill(name);
    if (existing) {
      return {
        success: false,
        error: `Skill "${name}" 已存在（来源: ${existing.source}, 路径: ${existing.basePath}）`,
      };
    }

    // 4. 确定目标路径
    const skillsDirs = getSkillsDir(context.workingDirectory);
    const targetDir =
      scope === 'project' && skillsDirs.project
        ? path.join(skillsDirs.project.new, name)
        : path.join(skillsDirs.user.new, name);

    const skillPath = path.join(targetDir, 'SKILL.md');

    // 5. 构建 + 写入
    const skillMd = buildSkillMd({ name, description, content, allowedTools });

    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(skillPath, skillMd, 'utf-8');
    } catch (error) {
      return {
        success: false,
        error: `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    logger.info('Auto-created skill', { name, scope, path: skillPath });

    // 6. skillWatcher 会自动 reload（500ms 防抖），这里不需要主动调用

    return {
      success: true,
      output: [
        `Skill "${name}" 已创建`,
        `路径: ${skillPath}`,
        `描述: ${description}`,
        `范围: ${scope}`,
        '',
        `使用方式: skill({ command: "${name}" }) 或 /${name}`,
      ].join('\n'),
    };
  },
};
