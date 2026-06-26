// ============================================================================
// SkillCreate (P0-6.x — native ToolModule rewrite)
//
// 旧版（已删除）: src/main/tools/skill/skillCreateTool.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - skill registry 不可达 → NOT_INITIALIZED
// - 行为保真：名称校验、长度校验、去重检查、scope 解析、frontmatter 构建
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getSkillDiscoveryService } from '../../../services/skills';
import { getSkillsDir } from '../../../config/configPaths';
import { skillCreateSchema as schema } from './skillCreate.schema';

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

export async function executeSkillCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // 1. 入参类型校验
  if (typeof args.name !== 'string') {
    return { ok: false, error: 'name must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof args.description !== 'string') {
    return { ok: false, error: 'description must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof args.content !== 'string') {
    return { ok: false, error: 'content must be a string', code: 'INVALID_ARGS' };
  }

  const name = args.name.trim();
  const description = args.description.trim();
  const content = args.content;
  const scope = (typeof args.scope === 'string' ? args.scope.trim() : '') || 'user';
  const allowedTools = typeof args.allowedTools === 'string' ? args.allowedTools : undefined;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'create skill' });

  // 2. 名称校验（与 legacy 保持一致：error 文案 prefix "名称无效: "）
  const nameError = validateName(name);
  if (nameError) {
    return { ok: false, error: `名称无效: ${nameError}`, code: 'INVALID_ARGS' };
  }

  // 3. 描述长度校验
  if (description.length > 1024) {
    return { ok: false, error: `描述超长: ${description.length}/1024`, code: 'INVALID_ARGS' };
  }

  // 4. 去重检查（registry 必须可用）
  const discoveryService = getSkillDiscoveryService();
  if (!discoveryService) {
    return { ok: false, error: 'Skill discovery service is not available.', code: 'NOT_INITIALIZED' };
  }
  try {
    await discoveryService.ensureInitialized(ctx.workingDir || process.cwd());
  } catch {
    // 初始化失败不阻塞，继续去重检查（保留 legacy 行为）
  }

  const existing = discoveryService.getSkill(name);
  if (existing) {
    return {
      ok: false,
      error: `Skill "${name}" 已存在（来源: ${existing.source}, 路径: ${existing.basePath}）`,
      code: 'SKILL_EXISTS',
    };
  }

  // 5. 确定目标路径
  const skillsDirs = getSkillsDir(ctx.workingDir);
  const targetDir =
    scope === 'project' && skillsDirs.project
      ? path.join(skillsDirs.project.new, name)
      : path.join(skillsDirs.user.new, name);

  const skillPath = path.join(targetDir, 'SKILL.md');

  // 6. 构建 + 写入
  const skillMd = buildSkillMd({ name, description, content, allowedTools });

  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(skillPath, skillMd, 'utf-8');
  } catch (error) {
    return {
      ok: false,
      error: `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      code: 'FS_ERROR',
    };
  }

  ctx.logger.info('Auto-created skill', { name, scope, path: skillPath });

  onProgress?.({ stage: 'completing', percent: 100 });

  // 7. skillWatcher 会自动 reload（500ms 防抖），这里不需要主动调用
  return {
    ok: true,
    output: [
      `Skill "${name}" 已创建`,
      `路径: ${skillPath}`,
      `描述: ${description}`,
      `范围: ${scope}`,
      '',
      `使用方式: skill({ command: "${name}" }) 或 /${name}`,
    ].join('\n'),
    meta: { name, scope, path: skillPath },
  };
}

class SkillCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeSkillCreate(args, ctx, canUseTool, onProgress);
  }
}

export const skillCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SkillCreateHandler();
  },
};
