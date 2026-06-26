// ============================================================================
// MCP Add Server (Wave 2 — mcp: native ToolModule rewrite)
//
// 旧版: src/host/tools/mcp/mcpAddServer.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / DOMAIN_ERROR
// - 行为保真：legacy 输出格式（包括 Configuration saved / Connection / 自动连接
//   失败提示）1:1 复刻；BLOCKED_COMMANDS、SSE URL 校验逻辑保留
//
// ABORT 纪律：
//   mcpClient 是共享单例。abort 时**不杀已添加的 server / 不 disconnect**：
//   - addServer 已写入 client 的 serverConfigs map，移除会破坏并发状态
//   - 实际异步段在 connect()，连接中途 abort 我们检测到后停在 race，但 client
//     内部还会继续完成连接（让它走完 → 下次调用就能用，不浪费 stdio 启动开销）
//   - sentinel：mcpClient.disconnect / mcpClient.removeServer 必须未被调用
//
// 配置写入纪律：
//   PR #93 ConfigService 收敛只覆盖 IReadConfigService（read 接口）。
//   MCP server 配置写入仍走 fs + getMcpConfigPath/ensureConfigDir/pathExists 三个
//   纯工具函数（不是 ConfigService 实例方法），language/语义没变。
// ============================================================================

import fs from 'fs/promises';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  getMCPClient,
  type MCPServerConfig,
  type MCPStdioServerConfig,
  type MCPSSEServerConfig,
  type MCPHttpStreamableServerConfig,
} from '../../../mcp/mcpClient';
import { getMcpConfigPath, ensureConfigDir, pathExists } from '../../../config';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { mcpAddServerSchema as schema } from './mcpAddServer.schema';

// ----------------------------------------------------------------------------
// Constants & validators (1:1 from legacy)
// ----------------------------------------------------------------------------

// Blocked commands for stdio servers (security)
const BLOCKED_COMMANDS = [
  'rm',
  'sudo',
  'chmod',
  'chown',
  'kill',
  'killall',
  'shutdown',
  'reboot',
  'dd',
  'mkfs',
  'fdisk',
  'mount',
  'umount',
];

type MCPAddServerTransport = 'http-streamable' | 'sse' | 'stdio';

function normalizeServerType(type: unknown): MCPAddServerTransport | null {
  if (type === 'http' || type === 'http-streamable') return 'http-streamable';
  if (type === 'sse' || type === 'stdio') return type;
  return null;
}

function validateStdioCommand(command: string): { valid: boolean; error?: string } {
  const normalizedCmd = command.toLowerCase().trim();
  const cmdName = normalizedCmd.split(/[\s/]/).pop() || '';

  for (const blocked of BLOCKED_COMMANDS) {
    if (cmdName === blocked) {
      return { valid: false, error: `Command '${blocked}' is not allowed for MCP servers` };
    }
  }

  return { valid: true };
}

function validateSSEUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        valid: false,
        error: `Invalid protocol: ${parsed.protocol}. Only http:// and https:// are allowed.`,
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

function buildMcpAddServerErrorMeta(input: {
  name?: string;
  type?: unknown;
  errorCode: string;
}): Record<string, unknown> {
  return {
    server: input.name,
    action: 'add_server',
    resultKind: 'process-output',
    count: 0,
    truncated: false,
    type: input.type,
    errorCode: input.errorCode,
  };
}

function buildMcpAddServerSuccessMeta(input: {
  name: string;
  type: MCPAddServerTransport;
  output: string;
  persisted: boolean;
  connected: boolean;
  toolCount?: number;
  resourceCount?: number;
  configPath?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const resultKind = 'process-output';
  const metadata = {
    mcpServer: true,
    server: input.name,
    action: 'add_server',
    resultKind,
    count: input.toolCount ?? 0,
    truncated: false,
    type: input.type,
    persisted: input.persisted,
    connected: input.connected,
    toolCount: input.toolCount,
    resourceCount: input.resourceCount,
    configPath: input.configPath,
  };
  return {
    name: input.name,
    server: input.name,
    type: input.type,
    action: 'add_server',
    resultKind,
    count: input.toolCount ?? 0,
    truncated: false,
    persisted: input.persisted,
    connected: input.connected,
    toolCount: input.toolCount,
    resourceCount: input.resourceCount,
    configPath: input.configPath,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: resultKind,
      sessionId: input.sessionId,
      name: `MCP server added: ${input.name}`,
      mimeType: 'text/plain',
      contentLength: input.output.length,
      preview: input.output.slice(0, 500),
      metadata,
    }),
  };
}

// ----------------------------------------------------------------------------
// Persist MCP server configuration (legacy 1:1, fs-only — 不走 ConfigService)
// ----------------------------------------------------------------------------

async function persistMCPConfig(
  workingDirectory: string,
  serverConfig: MCPServerConfig,
  logger: ToolContext['logger'],
): Promise<{ success: boolean; error?: string; filePath?: string }> {
  const mcpPaths = getMcpConfigPath(workingDirectory);

  try {
    const legacyExists = await pathExists(mcpPaths.legacy);
    const newExists = await pathExists(mcpPaths.new);

    let configPath: string;
    let isNewFormat: boolean;

    if (newExists) {
      configPath = mcpPaths.new;
      isNewFormat = true;
    } else if (legacyExists) {
      logger.info('Using legacy MCP config. Consider migrating to .code-agent/mcp.json');
      configPath = mcpPaths.legacy;
      isNewFormat = false;
    } else {
      await ensureConfigDir(workingDirectory);
      configPath = mcpPaths.new;
      isNewFormat = true;
    }

    let config: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // File missing or invalid JSON: start from empty
    }

    let mcpServers: MCPServerConfig[];
    if (isNewFormat) {
      if (!config.servers || !Array.isArray(config.servers)) {
        config.servers = [];
      }
      mcpServers = config.servers as MCPServerConfig[];
    } else {
      if (!config.mcpServers || !Array.isArray(config.mcpServers)) {
        config.mcpServers = [];
      }
      mcpServers = config.mcpServers as MCPServerConfig[];
    }

    const existingIndex = mcpServers.findIndex((s) => s.name === serverConfig.name);
    if (existingIndex >= 0) {
      mcpServers[existingIndex] = serverConfig;
    } else {
      mcpServers.push(serverConfig);
    }

    if (isNewFormat) {
      config.servers = mcpServers;
    } else {
      config.mcpServers = mcpServers;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return { success: true, filePath: configPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save configuration',
    };
  }
}

// ----------------------------------------------------------------------------
// Native execute
// ----------------------------------------------------------------------------

export async function executeMcpAddServer(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // ── 参数校验（行为保真：先校验 name） ─────────────────────
  const name = args.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return {
      ok: false,
      error: 'Server name is required and cannot be empty',
      code: 'INVALID_ARGS',
      meta: buildMcpAddServerErrorMeta({ type: args.type, errorCode: 'INVALID_ARGS' }),
    };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      ok: false,
      error: 'Server name can only contain letters, numbers, dashes, and underscores',
      code: 'INVALID_ARGS',
      meta: buildMcpAddServerErrorMeta({ name, type: args.type, errorCode: 'INVALID_ARGS' }),
    };
  }
  const type = normalizeServerType(args.type);
  if (!type) {
    return {
      ok: false,
      error: `Invalid server type: ${String(args.type)}. Use 'http-streamable', 'http', 'sse', or 'stdio'.`,
      code: 'INVALID_ARGS',
      meta: buildMcpAddServerErrorMeta({ name, type: args.type, errorCode: 'INVALID_ARGS' }),
    };
  }

  // ── 权限闸门 / abort ──────────────────────────────────
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return {
      ok: false,
      error: `permission denied: ${permit.reason}`,
      code: 'PERMISSION_DENIED',
      meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'PERMISSION_DENIED' }),
    };
  }
  if (ctx.abortSignal.aborted) {
    return {
      ok: false,
      error: 'aborted',
      code: 'ABORTED',
      meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'ABORTED' }),
    };
  }

  onProgress?.({ stage: 'starting', detail: `mcp_add_server ${name} (${type})` });

  const serverUrl = typeof args.serverUrl === 'string'
    ? args.serverUrl
    : typeof args.url === 'string'
      ? args.url
      : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const argsList = Array.isArray(args.args) ? (args.args as string[]) : undefined;
  const env =
    args.env && typeof args.env === 'object' && !Array.isArray(args.env)
      ? (args.env as Record<string, string>)
      : undefined;
  const headers =
    args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)
      ? (args.headers as Record<string, string>)
      : undefined;
  const autoConnect = typeof args.auto_connect === 'boolean' ? args.auto_connect : true;

  const mcpClient = getMCPClient();

  // 行为保真：已存在且已连接 → DOMAIN_ERROR
  const existingState = mcpClient.getServerState(name);
  if (existingState?.status === 'connected') {
    return {
      ok: false,
      error: `Server '${name}' is already connected. Use mcp_get_status to see connected servers.`,
      code: 'DOMAIN_ERROR',
      meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'DOMAIN_ERROR' }),
    };
  }

  // ── Build & validate config based on type ─────────────
  let serverConfig: MCPServerConfig;

  if (type === 'sse' || type === 'http-streamable') {
    if (!serverUrl) {
      return {
        ok: false,
        error: 'serverUrl is required for remote MCP server types',
        code: 'INVALID_ARGS',
        meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'INVALID_ARGS' }),
      };
    }
    const urlValidation = validateSSEUrl(serverUrl);
    if (!urlValidation.valid) {
      return {
        ok: false,
        error: urlValidation.error || 'Invalid URL',
        code: 'INVALID_ARGS',
        meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'INVALID_ARGS' }),
      };
    }
    if (type === 'sse') {
      serverConfig = {
        name,
        type: 'sse',
        serverUrl,
        headers,
        enabled: true,
      } as MCPSSEServerConfig;
    } else {
      serverConfig = {
        name,
        type: 'http-streamable',
        serverUrl,
        headers,
        enabled: true,
      } as MCPHttpStreamableServerConfig;
    }
  } else {
    if (!command) {
      return {
        ok: false,
        error: 'command is required for Stdio type',
        code: 'INVALID_ARGS',
        meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'INVALID_ARGS' }),
      };
    }
    const cmdValidation = validateStdioCommand(command);
    if (!cmdValidation.valid) {
      ctx.logger.warn('Blocked dangerous command for MCP server', { command });
      return {
        ok: false,
        error: cmdValidation.error || 'Blocked command',
        code: 'INVALID_ARGS',
        meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'INVALID_ARGS' }),
      };
    }
    serverConfig = {
      name,
      type: 'stdio',
      command,
      args: argsList || [],
      env: env || {},
      enabled: true,
    } as MCPStdioServerConfig;
  }

  // ── Persist configuration（fs 写入，不走 ConfigService）──
  const persistResult = await persistMCPConfig(ctx.workingDir, serverConfig, ctx.logger);
  if (!persistResult.success) {
    ctx.logger.warn('Failed to persist MCP config:', persistResult.error);
  }

  // ── Add server to client（singleton 状态变更，abort 后不回滚）──
  mcpClient.addServer(serverConfig);
  ctx.logger.info(`Added MCP server: ${name}`, { type, autoConnect });

  // ── Connect if auto_connect ───────────────────────────
  let connectResult: { success: boolean; error?: string; toolCount?: number } = { success: true };

  if (autoConnect) {
    if (ctx.abortSignal.aborted) {
      // 已添加 + 已落盘，但用户取消了自动连接：当作 ABORTED 返回
      return {
        ok: false,
        error: 'aborted',
        code: 'ABORTED',
        meta: buildMcpAddServerErrorMeta({ name, type, errorCode: 'ABORTED' }),
      };
    }
    try {
      // mcpClient.connect 没有原生 abortSignal 支持；我们让它跑完，依赖
      // SDK 内部的 connectTimeout 兜底。abort 只影响后续报告，不杀 client。
      await mcpClient.connect(serverConfig);
      const state = mcpClient.getServerState(name);
      connectResult = {
        success: true,
        toolCount: state?.toolCount || 0,
      };
      ctx.logger.info(`Connected to MCP server: ${name}`, {
        type,
        toolCount: state?.toolCount,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Connection failed';
      connectResult = { success: false, error: errorMessage };
      ctx.logger.error(`Failed to connect to MCP server ${name}:`, error);
    }
  }

  // ── Build output（行为保真：legacy outputParts 拼接顺序与措辞） ──
  const outputParts: string[] = [`# MCP Server Added: ${name}`, '', `Type: ${type}`];

  if (type === 'sse' || type === 'http-streamable') {
    outputParts.push(`URL: ${serverUrl}`);
  } else {
    const cmdDisplay = [command, ...(argsList || [])].join(' ');
    outputParts.push(`Command: ${cmdDisplay}`);
    if (env && Object.keys(env).length > 0) {
      outputParts.push(`Environment: ${Object.keys(env).join(', ')}`);
    }
  }

  outputParts.push('');
  outputParts.push(
    `Configuration saved: ${persistResult.success ? `Yes (${persistResult.filePath})` : 'No (session only)'}`,
  );

  if (autoConnect) {
    outputParts.push('');
    if (connectResult.success) {
      outputParts.push('Connection: Success');
      outputParts.push(`Available tools: ${connectResult.toolCount || 0}`);
      outputParts.push('');
      outputParts.push('Use `mcp_list_tools` to see available tools from this server.');
    } else {
      outputParts.push('Connection: Failed');
      outputParts.push(`Error: ${connectResult.error}`);
      outputParts.push('');
      outputParts.push(
        'The server configuration has been saved. You can try connecting later.',
      );
    }
  } else {
    outputParts.push('');
    outputParts.push('Auto-connect disabled. Use mcp_get_status to see server status.');
  }

  ctx.logger.debug('mcp_add_server done', { name, type, ok: true });
  onProgress?.({ stage: 'completing', percent: 100 });

  return {
    ok: true,
    output: outputParts.join('\n'),
    meta: buildMcpAddServerSuccessMeta({
      name,
      type,
      persisted: persistResult.success,
      connected: autoConnect ? connectResult.success : false,
      toolCount: connectResult.toolCount,
      output: outputParts.join('\n'),
      configPath: persistResult.filePath,
      sessionId: ctx.sessionId,
    }),
  };
}

class McpAddServerHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMcpAddServer(args, ctx, canUseTool, onProgress);
  }
}

export const mcpAddServerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpAddServerHandler();
  },
};
