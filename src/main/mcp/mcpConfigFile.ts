// ============================================================================
// MCP Config File Loader — .mcp.json 配置文件 + scope 分层（G25 Item 2）
//
// 对标 Claude Code 的 .mcp.json + scope 设计，让 MCP 配置可随项目走、
// 团队共享、纳入版本控制。三档 scope：
//   - user:    ~/.code-agent/mcp.json
//   - project: <wd>/.code-agent/mcp.json   （版本控制、团队共享）
//   - local:   <wd>/.code-agent/mcp.local.json （项目内私有、应 gitignore）
//
// 文件格式同时支持：
//   - 原生数组格式 { "servers": MCPServerConfig[] }（mcp_add_server 写入的格式）
//   - Claude Code 兼容对象格式 { "mcpServers": { "<name>": { ... } } }
//   同一文件两种都有时，servers 数组优先（同名跳过 mcpServers 项）。
// ============================================================================

import fs from 'fs/promises';
import { createLogger } from '../services/infra/logger';
import { getMcpScopedConfigPaths } from '../config/configPaths';
import type { MCPServerConfig, MCPConfigScope } from './types';

const logger = createLogger('MCPConfigFile');

/** Claude Code 兼容格式的 mcpServers 条目 */
interface ClaudeCodeMcpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验并规范化原生数组格式条目（已是 MCPServerConfig 形状，补 scope + enabled 默认值）
 */
function normalizeNativeEntry(raw: unknown, scope: MCPConfigScope): MCPServerConfig | null {
  if (!isRecord(raw)) return null;
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    logger.warn(`Skipping ${scope} MCP entry: missing or invalid "name"`);
    return null;
  }

  const type = raw.type;
  const hasCommand = typeof raw.command === 'string' && raw.command.length > 0;
  const hasUrl = typeof raw.serverUrl === 'string' && raw.serverUrl.length > 0;

  if (!hasCommand && !hasUrl && type !== 'in-process') {
    logger.warn(`Skipping ${scope} MCP entry "${name}": needs "command" or "serverUrl"`);
    return null;
  }

  // 文件里出现即默认启用（除非显式 enabled: false）
  const enabled = raw.enabled !== false;
  return { ...(raw as object), name, enabled, scope } as MCPServerConfig;
}

/**
 * 规范化 Claude Code 兼容格式条目（对象 key 为 server 名）
 */
function normalizeClaudeEntry(
  name: string,
  raw: ClaudeCodeMcpEntry,
  scope: MCPConfigScope,
): MCPServerConfig | null {
  const enabled = raw.enabled !== false;

  if (typeof raw.command === 'string' && raw.command.length > 0) {
    return {
      name,
      type: 'stdio',
      command: raw.command,
      args: raw.args || [],
      env: raw.env || {},
      enabled,
      scope,
    };
  }

  const url = raw.serverUrl || raw.url;
  if (typeof url === 'string' && url.length > 0) {
    const type = raw.type === 'sse' ? 'sse' : 'http-streamable';
    return {
      name,
      type,
      serverUrl: url,
      headers: raw.headers,
      enabled,
      scope,
    } as MCPServerConfig;
  }

  logger.warn(`Skipping ${scope} MCP entry "${name}": needs "command" or "url"`);
  return null;
}

/**
 * 读取并解析单个 scope 的 .mcp.json 文件。
 * 文件缺失返回空数组；JSON 非法记 warn 并返回空数组（不阻塞初始化）。
 */
async function readScopeFile(filePath: string, scope: MCPConfigScope): Promise<MCPServerConfig[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return []; // 文件不存在 = 该 scope 无配置
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    logger.warn(`Invalid JSON in ${filePath}, skipping ${scope} MCP config`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (!isRecord(parsed)) {
    logger.warn(`${filePath} is not a JSON object, skipping ${scope} MCP config`);
    return [];
  }

  const result: MCPServerConfig[] = [];

  // 原生数组格式
  if (Array.isArray(parsed.servers)) {
    for (const entry of parsed.servers) {
      const normalized = normalizeNativeEntry(entry, scope);
      if (normalized) result.push(normalized);
    }
  }

  // Claude Code 兼容对象格式（同名时原生数组优先）
  if (isRecord(parsed.mcpServers)) {
    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      if (result.some((s) => s.name === name)) continue;
      if (!isRecord(entry)) {
        logger.warn(`Skipping ${scope} MCP entry "${name}": not an object`);
        continue;
      }
      const normalized = normalizeClaudeEntry(name, entry as ClaudeCodeMcpEntry, scope);
      if (normalized) result.push(normalized);
    }
  }

  if (result.length > 0) {
    logger.info(`Loaded ${result.length} MCP servers from ${scope} config: ${filePath}`);
  }
  return result;
}

/**
 * 加载 user / project / local 三档 .mcp.json 配置。
 * 返回顺序为 [user..., project..., local...]，调用方按序 addServer 即可实现
 * local > project > user 的同名覆盖优先级。
 */
export async function loadMcpConfigFiles(workingDirectory?: string): Promise<MCPServerConfig[]> {
  const paths = getMcpScopedConfigPaths(workingDirectory);
  const result: MCPServerConfig[] = [];

  result.push(...(await readScopeFile(paths.user, 'user')));
  if (paths.project) {
    result.push(...(await readScopeFile(paths.project, 'project')));
  }
  if (paths.local) {
    result.push(...(await readScopeFile(paths.local, 'local')));
  }

  return result;
}
