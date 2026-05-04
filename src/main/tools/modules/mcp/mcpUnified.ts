// ============================================================================
// MCP Unified (Wave 2 — mcp: native ToolModule rewrite)
//
// 旧版: src/main/tools/mcp/MCPUnifiedTool.ts (legacy Tool dispatching to 6 sub
// tools: mcpTool / mcpListToolsTool / mcpListResourcesTool / mcpReadResourceTool /
// mcpGetStatusTool / mcpAddServerTool)
//
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - 行为保真：6 个 action 的输出格式（含中文文案、emoji、表头）1:1 复刻 legacy
// - invoke / add_server 复用 sibling executeMcpInvoke / executeMcpAddServer，
//   list_tools / list_resources / read_resource / status 内联实现
//
// ABORT 纪律：
//   MCP server 是共享 stdio/HTTP 子进程单例。**绝对不在 abort 时 disconnect /
//   removeServer**。invoke / read_resource 中 race signal 让长连接立即 ABORTED，
//   client 内部 timeout 兜底；list_*/status 是纯本地查询，不需要 abort 处理。
//   sentinel：mcpClient.disconnect / mcpClient.removeServer 必须未被调用。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getMCPClient } from '../../../mcp/mcpClient';
import { mcpUnifiedSchema as schema } from './mcpUnified.schema';
import { executeMcpInvoke } from './mcpInvoke';
import { executeMcpAddServer } from './mcpAddServer';

type MCPAction =
  | 'invoke'
  | 'list_tools'
  | 'list_resources'
  | 'read_resource'
  | 'status'
  | 'add_server';

const ALLOWED_ACTIONS: MCPAction[] = [
  'invoke',
  'list_tools',
  'list_resources',
  'read_resource',
  'status',
  'add_server',
];

// ----------------------------------------------------------------------------
// Abort utilities (race signal vs MCP request — 不杀 client)
// ----------------------------------------------------------------------------

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.message === 'aborted';
}

// ----------------------------------------------------------------------------
// Action: list_tools (1:1 from legacy mcpListToolsTool)
// ----------------------------------------------------------------------------

function actionListTools(args: Record<string, unknown>): ToolResult<string> {
  const filterServer = typeof args.server === 'string' ? args.server : undefined;

  const mcpClient = getMCPClient();
  const status = mcpClient.getStatus();

  if (status.connectedServers.length === 0) {
    return {
      ok: true,
      output: '当前没有已连接的 MCP 服务器。',
    };
  }

  const tools = mcpClient.getTools();

  const toolsByServer: Record<string, typeof tools> = {};
  for (const tool of tools) {
    if (filterServer && tool.serverName !== filterServer) {
      continue;
    }
    if (!toolsByServer[tool.serverName]) {
      toolsByServer[tool.serverName] = [];
    }
    toolsByServer[tool.serverName].push(tool);
  }

  const lines: string[] = [];
  lines.push(`已连接的 MCP 服务器: ${status.connectedServers.join(', ')}`);
  lines.push(`总工具数: ${status.toolCount}`);
  lines.push('');

  for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
    lines.push(`## ${serverName} (${serverTools.length} 个工具)`);
    lines.push('');

    for (const tool of serverTools) {
      lines.push(`### ${tool.name}`);
      lines.push(tool.description || '无描述');

      // 简化 schema 输出（保留 legacy 的 inputSchema 解构方式）
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        // MCP protocol response shape 由远端 server 决定，无固定 TS 类型；
        // 这里复刻 legacy 的运行时 narrow（inputSchema: unknown → properties/required）
        const inputSchema = tool.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        if (inputSchema.properties) {
          lines.push('参数:');
          for (const [propName, propDef] of Object.entries(inputSchema.properties)) {
            const def = propDef as { type?: string; description?: string };
            const required = inputSchema.required?.includes(propName) ? '(必需)' : '(可选)';
            lines.push(`  - ${propName}: ${def.type || 'any'} ${required}`);
            if (def.description) {
              lines.push(`    ${def.description}`);
            }
          }
        }
      }
      lines.push('');
    }
  }

  return { ok: true, output: lines.join('\n') };
}

// ----------------------------------------------------------------------------
// Action: list_resources (1:1 from legacy mcpListResourcesTool)
// ----------------------------------------------------------------------------

function actionListResources(args: Record<string, unknown>): ToolResult<string> {
  const filterServer = typeof args.server === 'string' ? args.server : undefined;
  const mcpClient = getMCPClient();
  const resources = mcpClient.getResources();

  const filtered = filterServer
    ? resources.filter((r) => r.serverName === filterServer)
    : resources;

  if (filtered.length === 0) {
    return {
      ok: true,
      output: filterServer
        ? `服务器 '${filterServer}' 没有提供资源。`
        : '当前没有可用的 MCP 资源。',
    };
  }

  const resourcesByServer: Record<string, typeof filtered> = {};
  for (const resource of filtered) {
    if (!resourcesByServer[resource.serverName]) {
      resourcesByServer[resource.serverName] = [];
    }
    resourcesByServer[resource.serverName].push(resource);
  }

  const lines: string[] = [];
  lines.push(`共 ${filtered.length} 个资源`);
  lines.push('');

  for (const [serverName, serverResources] of Object.entries(resourcesByServer)) {
    lines.push(`## ${serverName}`);
    for (const resource of serverResources) {
      lines.push(`- ${resource.name}`);
      lines.push(`  URI: ${resource.uri}`);
      if (resource.description) {
        lines.push(`  描述: ${resource.description}`);
      }
      if (resource.mimeType) {
        lines.push(`  类型: ${resource.mimeType}`);
      }
    }
    lines.push('');
  }

  return { ok: true, output: lines.join('\n') };
}

// ----------------------------------------------------------------------------
// Action: read_resource (1:1 from legacy mcpReadResourceTool)
// ----------------------------------------------------------------------------

async function actionReadResource(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const server = args.server;
  const uri = args.uri;

  if (typeof server !== 'string' || server.length === 0 ||
      typeof uri !== 'string' || uri.length === 0) {
    return { ok: false, error: '缺少必需参数: server 和 uri', code: 'INVALID_ARGS' };
  }

  const mcpClient = getMCPClient();

  if (!mcpClient.isConnected(server)) {
    return {
      ok: false,
      error: `MCP 服务器 '${server}' 未连接`,
      code: 'NOT_INITIALIZED',
    };
  }

  try {
    const content = await withAbort(mcpClient.readResource(server, uri), ctx.abortSignal);
    return {
      ok: true,
      output: content,
      meta: { server, uri },
    };
  } catch (error: unknown) {
    if (isAbortError(error) || ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    return {
      ok: false,
      error: `读取资源失败: ${errorMessage}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

// ----------------------------------------------------------------------------
// Action: status (1:1 from legacy mcpGetStatusTool)
// ----------------------------------------------------------------------------

function actionStatus(): ToolResult<string> {
  const mcpClient = getMCPClient();
  const status = mcpClient.getStatus();

  const output = [
    '# MCP 连接状态',
    '',
    `已连接服务器: ${status.connectedServers.length > 0 ? status.connectedServers.join(', ') : '无'}`,
    `可用工具: ${status.toolCount}`,
    `可用资源: ${status.resourceCount}`,
    `可用提示: ${status.promptCount}`,
  ].join('\n');

  return {
    ok: true,
    output,
    meta: { ...status },
  };
}

// ----------------------------------------------------------------------------
// Native execute (dispatcher)
// ----------------------------------------------------------------------------

export async function executeMcpUnified(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // ── 参数校验：action 必须先校验，否则 dispatch 不到 ─────
  const action = args.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action as MCPAction)) {
    return {
      ok: false,
      error: `Unknown action: ${String(action)}. Valid actions: invoke, list_tools, list_resources, read_resource, status, add_server`,
      code: 'INVALID_ARGS',
    };
  }

  // ── 权限闸门 / abort 检查（统一前置一次；invoke/add_server 还会再走自己的）
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `MCPUnified ${action}` });

  let result: ToolResult<string>;

  // 委托给 sibling native 实现：传入一个 always-allow canUseTool（顶层已经 gate 过）
  const noopCanUse: CanUseToolFn = async () => ({ allow: true });

  switch (action as MCPAction) {
    case 'invoke':
      result = await executeMcpInvoke(args, ctx, noopCanUse);
      break;
    case 'add_server':
      result = await executeMcpAddServer(args, ctx, noopCanUse);
      break;
    case 'list_tools':
      result = actionListTools(args);
      break;
    case 'list_resources':
      result = actionListResources(args);
      break;
    case 'read_resource':
      result = await actionReadResource(args, ctx);
      break;
    case 'status':
      result = actionStatus();
      break;
  }

  ctx.logger.debug('MCPUnified done', { action, ok: result.ok });
  onProgress?.({ stage: 'completing', percent: 100 });
  return result;
}

class McpUnifiedHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMcpUnified(args, ctx, canUseTool, onProgress);
  }
}

export const mcpUnifiedModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpUnifiedHandler();
  },
};
