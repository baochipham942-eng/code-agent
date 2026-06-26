// ============================================================================
// CommandFileEmitter — distill 产出 command 的确定性落盘通道（roadmap 3.2）
// ============================================================================
// command 文件的写入与注册语义归 commands 域（与 promptCommandService 同域）。
// 设计约束（对抗审计裁决）：
// - 路径由代码从 sanitize 后的 name 构造，调用方（含 LLM 提案）不控制任何路径
// - frontmatter 白名单：只写 description。agent/model/subtask 一律不产出——
//   自动产出的 command 不得携带子代理路由/模型覆盖（注入面）
// - 重名拒绝（fs 'wx' 原子排他写入），不静默覆盖
// - 写前 parsePromptCommandFile 回读自检（产出物必须能被注册通道解析）
// - draft 模式落 command-drafts 目录（不被 promptCommandService 扫描），
//   人不在场产出物一律不激活；activateCommandDraft 是确认后的激活入口
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { DISTILL } from '../../../shared/constants';
import { getUserConfigDir } from '../../config/configPaths';
import { parsePromptCommandFile } from '../../../shared/commands/promptCommands';
import { createLogger } from '../infra/logger';

const logger = createLogger('CommandFileEmitter');

/** 与 SkillCreate 的名称规则一致：小写字母开头，小写字母/数字/连字符 */
const COMMAND_NAME_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export interface CommandEmitInput {
  name: string;
  description: string;
  /** 命令模板正文（支持 $1/$ARGUMENTS 占位符） */
  body: string;
}

export interface CommandEmitterDirs {
  /** 激活命令目录；缺省用户级 ~/.code-agent/commands */
  commandsDir?: string;
  /** 草稿目录；缺省 ~/.code-agent/command-drafts */
  draftsDir?: string;
}

export interface CommandEmitOptions extends CommandEmitterDirs {
  draft: boolean;
}

export interface CommandEmitResult {
  location: string;
  activated: boolean;
}

function resolveDirs(dirs: CommandEmitterDirs): { commandsDir: string; draftsDir: string } {
  return {
    commandsDir: dirs.commandsDir ?? path.join(getUserConfigDir(), 'commands'),
    draftsDir: dirs.draftsDir ?? path.join(getUserConfigDir(), DISTILL.COMMAND_DRAFTS_DIR_NAME),
  };
}

function validateName(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed || trimmed.length > DISTILL.NAME_MAX_LENGTH || !COMMAND_NAME_PATTERN.test(trimmed)) {
    throw new Error(`命令名称无效: "${name}"（只允许小写字母/数字/连字符，且以小写字母开头，≤${DISTILL.NAME_MAX_LENGTH} 字符）`);
  }
  return trimmed;
}

/** 单行化 + 截断：description 进 frontmatter 前必须不可注入（换行会开新 frontmatter 键） */
function sanitizeDescription(description: string): string {
  const flat = (description || '').replace(/\s+/g, ' ').trim();
  if (!flat) {
    throw new Error('命令描述不能为空');
  }
  return flat.length <= DISTILL.DESCRIPTION_MAX_LENGTH
    ? flat
    : `${flat.slice(0, DISTILL.DESCRIPTION_MAX_LENGTH - 3).trimEnd()}...`;
}

function composeCommandFile(name: string, description: string, body: string): string {
  const raw = ['---', `description: "${description.replace(/"/g, "'")}"`, '---', '', body.trim(), ''].join('\n');
  // 回读自检：产出物必须能被 promptCommandService 的解析器还原，且不携带路由字段
  const parsed = parsePromptCommandFile(name, raw);
  if (!parsed.template) {
    throw new Error('回读自检失败: 模板为空');
  }
  if (parsed.agent !== undefined || parsed.model !== undefined || parsed.subtask !== undefined) {
    throw new Error('回读自检失败: 产出物携带了被禁止的 frontmatter 字段（agent/model/subtask）');
  }
  return raw;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function emitCommandFile(input: CommandEmitInput, options: CommandEmitOptions): Promise<CommandEmitResult> {
  const name = validateName(input.name);
  const description = sanitizeDescription(input.description);
  const body = (input.body || '').trim();
  if (!body) {
    throw new Error('命令模板正文不能为空');
  }
  if (body.length > DISTILL.BODY_MAX_LENGTH) {
    throw new Error(`命令模板超长: ${body.length} > ${DISTILL.BODY_MAX_LENGTH}`);
  }

  const { commandsDir, draftsDir } = resolveDirs(options);
  const activePath = path.join(commandsDir, `${name}.md`);
  const draftPath = path.join(draftsDir, `${name}.md`);

  // 重名门：active 与 draft 两个位置都不允许撞名（draft 撞 active 会在激活时冲突）
  if (await exists(activePath)) {
    throw new Error(`命令 "${name}" 已存在: ${activePath}`);
  }
  if (await exists(draftPath)) {
    throw new Error(`命令草稿 "${name}" 已存在: ${draftPath}`);
  }

  const content = composeCommandFile(name, description, body);
  const targetPath = options.draft ? draftPath : activePath;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  // 'wx' 排他写入：与上面的 exists 检查双保险，并发场景不覆盖
  await fs.writeFile(targetPath, content, { encoding: 'utf-8', flag: 'wx' });
  logger.info('Command emitted', { name, draft: options.draft, path: targetPath });
  return { location: targetPath, activated: !options.draft };
}

/** 用户确认后把 command 草稿移入激活目录（确认流的激活入口） */
export async function activateCommandDraft(name: string, dirs: CommandEmitterDirs = {}): Promise<CommandEmitResult> {
  const validName = validateName(name);
  const { commandsDir, draftsDir } = resolveDirs(dirs);
  const draftPath = path.join(draftsDir, `${validName}.md`);
  const activePath = path.join(commandsDir, `${validName}.md`);

  if (!(await exists(draftPath))) {
    throw new Error(`命令草稿 "${validName}" 不存在: ${draftPath}`);
  }
  if (await exists(activePath)) {
    throw new Error(`命令 "${validName}" 已存在: ${activePath}（草稿保留，请先处理冲突）`);
  }
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.rename(draftPath, activePath);
  logger.info('Command draft activated', { name: validName, path: activePath });
  return { location: activePath, activated: true };
}
