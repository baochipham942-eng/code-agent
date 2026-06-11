// ============================================================================
// PromptCommandService — /命令注册表 + 调用解析（roadmap 2.2）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — command/index.ts
// 的注册表组装（文件式自定义 + MCP prompts 自动入表 + 同名优先级）。
//
// 命令来源与优先级（同名时左边赢）：
//   project 文件 > user 文件 > MCP prompt
// 文件式：~/.code-agent/commands/<name>.md 与 <wd>/.code-agent/commands/<name>.md，
// frontmatter 见 shared/commands/promptCommands.ts。
// 每次调用现扫目录（命令文件小、聊天频率低，不做缓存/watcher——与 MiMo 的
// InstanceState 缓存不同构，Neo 侧热加载语义靠现扫天然成立）。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMCPClient } from '../../mcp/mcpClient';
import { getCommandsDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';
import {
  expandPromptTemplate,
  parsePromptCommandFile,
  parseSlashInvocation,
  tokenizeArgs,
  type PromptCommandInfo,
  type PromptCommandResolution,
} from '../../../shared/commands/promptCommands';

const logger = createLogger('PromptCommandService');

async function readCommandFiles(dir: string, scope: 'user' | 'project'): Promise<PromptCommandInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const commands: PromptCommandInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry.startsWith('.')) continue;
    const name = entry.slice(0, -3);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
      const parsed = parsePromptCommandFile(name, raw);
      if (!parsed.template) continue;
      commands.push({ ...parsed, scope });
    } catch (err) {
      logger.warn('Failed to load command file', { dir, entry, error: String(err) });
    }
  }
  return commands;
}

export class PromptCommandService {
  /**
   * 全量命令清单（project 文件 > user 文件 > MCP prompt，按名去重）。
   */
  async listCommands(workingDirectory?: string): Promise<PromptCommandInfo[]> {
    const dirs = getCommandsDir(workingDirectory);
    const byName = new Map<string, PromptCommandInfo>();

    // 注册顺序 = 优先级倒序：后写的不覆盖已有的
    const ordered: PromptCommandInfo[] = [
      ...(dirs.project ? await readCommandFiles(dirs.project, 'project') : []),
      ...(await readCommandFiles(dirs.user, 'user')),
      ...this.listMcpPromptCommands(),
    ];
    for (const command of ordered) {
      if (!byName.has(command.name)) {
        byName.set(command.name, command);
      }
    }
    return [...byName.values()];
  }

  private listMcpPromptCommands(): PromptCommandInfo[] {
    try {
      const prompts = getMCPClient().getPrompts();
      return prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        source: 'mcp' as const,
        template: '',
        hints: (prompt.arguments ?? []).map((_, i) => `$${i + 1}`),
        serverName: prompt.serverName,
      }));
    } catch (err) {
      logger.debug('MCP prompts unavailable', { error: String(err) });
      return [];
    }
  }

  /**
   * 把 "/name args" 解析成可发给模型的 prompt。非命令或未注册返回 null。
   * mcp 命令：位置参数按 prompt 声明的 argument 名映射后远程获取模板。
   */
  async resolveInvocation(content: string, workingDirectory?: string): Promise<PromptCommandResolution | null> {
    const invocation = parseSlashInvocation(content);
    if (!invocation) {
      return null;
    }

    const commands = await this.listCommands(workingDirectory);
    const command = commands.find((c) => c.name === invocation.name);
    if (!command) {
      return null;
    }

    if (command.source === 'mcp') {
      const prompts = getMCPClient().getPrompts();
      const prompt = prompts.find((p) => p.name === command.name && p.serverName === command.serverName);
      const tokens = tokenizeArgs(invocation.args);
      const argsMap = Object.fromEntries(
        (prompt?.arguments ?? []).map((argument, i) => [argument.name, tokens[i] ?? '']),
      );
      const template = await getMCPClient().getPrompt(command.serverName ?? '', command.name, argsMap);
      return {
        name: command.name,
        prompt: template,
        source: 'mcp',
      };
    }

    return {
      name: command.name,
      prompt: expandPromptTemplate(command.template, invocation.args),
      source: 'file',
      agent: command.agent,
      model: command.model,
      subtask: command.subtask,
    };
  }
}

let singleton: PromptCommandService | null = null;

export function getPromptCommandService(): PromptCommandService {
  if (!singleton) {
    singleton = new PromptCommandService();
  }
  return singleton;
}

/**
 * 消息入口的 /命令展开 choke point（appService.sendMessage / CLI 共用）。
 * - 命中注册命令：content 换成展开后的 prompt；frontmatter agent →
 *   options.agentOverrideId（接 agentOrchestrator 的显式路由）
 * - 非命令 / 未注册 / 解析失败：原样返回，绝不阻塞消息链路
 * - model/subtask 暂只解析保留（消息级模型路由与子任务运行待后续接入）
 */
export async function applyPromptCommandExpansion<
  T extends { content: string; options?: Record<string, unknown> },
>(envelope: T, workingDirectory?: string): Promise<T> {
  if (!envelope.content?.startsWith('/')) {
    return envelope;
  }
  try {
    const resolution = await getPromptCommandService().resolveInvocation(envelope.content, workingDirectory);
    if (!resolution) {
      return envelope;
    }
    logger.info('Expanded prompt command', { name: resolution.name, source: resolution.source });
    return {
      ...envelope,
      content: resolution.prompt,
      options: {
        ...envelope.options,
        ...(resolution.agent ? { agentOverrideId: resolution.agent } : {}),
      },
    };
  } catch (err) {
    logger.warn('Prompt command expansion failed; sending message as-is', { error: String(err) });
    return envelope;
  }
}
