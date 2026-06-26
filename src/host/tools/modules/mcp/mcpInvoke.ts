// ============================================================================
// MCP Invoke (Wave 2 — mcp: native ToolModule rewrite)
//
// 旧版: src/main/tools/mcp/mcpTool.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - 行为保真：legacy mcpTool 输出格式与中文文案 1:1 复刻
//
// ABORT 纪律：
//   MCP server 是共享 stdio 子进程单例（与 LSP 同模式），**绝对不在 abort 时
//   disconnect / kill 进程**（其他 in-flight invoke 还在用同一个 server）。
//   - mcpClient.callTool 内部已支持 AbortSignal，pending request 由内部 timeout
//     和 SDK 层清理
//   - 这里再叠一层 race（withAbort）让 abort 能立刻返回，避免在 callTool resolved
//     之前 hang 住 onProgress 完成事件
//   - sentinel：mcpClient.disconnect / removeServer 必须未被调用
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getMCPClient } from '../../../mcp/mcpClient';
import { getContextHealthService } from '../../../context/contextHealthService';
import { estimateTokens } from '../../../context/tokenEstimator';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { mcpInvokeSchema as schema } from './mcpInvoke.schema';

// ----------------------------------------------------------------------------
// Abort utilities — race signal vs callTool Promise，不杀 client / 不 disconnect
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

function buildMcpInvokeMeta(input: {
  server: string;
  tool: string;
  output?: string;
  duration?: number;
  errorCode?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const output = input.output ?? '';
  const resultKind = 'process-output';
  const base = {
    server: input.server,
    tool: input.tool,
    toolName: input.tool,
    action: 'invoke',
    resultKind,
    count: output.length > 0 ? 1 : 0,
    truncated: false,
    duration: input.duration,
    errorCode: input.errorCode,
  };

  if (input.errorCode) {
    return base;
  }

  return {
    ...base,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: resultKind,
      sessionId: input.sessionId,
      name: `MCP tool call: ${input.server}.${input.tool}`,
      mimeType: 'text/plain',
      contentLength: output.length,
      preview: output.slice(0, 500),
      metadata: {
        mcpToolCall: true,
        server: input.server,
        tool: input.tool,
        toolName: input.tool,
        action: 'invoke',
        resultKind,
        count: output.length > 0 ? 1 : 0,
        truncated: false,
        duration: input.duration,
      },
    }),
  };
}

// ----------------------------------------------------------------------------
// Native execute
// ----------------------------------------------------------------------------

export async function executeMcpInvoke(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // ── 参数校验 ────────────────────────────────────────────
  const server = args.server;
  const tool = args.tool;
  if (typeof server !== 'string' || server.length === 0 ||
      typeof tool !== 'string' || tool.length === 0) {
    return {
      ok: false,
      error: '缺少必需参数: server 和 tool',
      code: 'INVALID_ARGS',
      meta: { action: 'invoke', resultKind: 'process-output', count: 0, truncated: false, errorCode: 'INVALID_ARGS' },
    };
  }
  const toolArgsRaw = args.arguments;
  const toolArgs: Record<string, unknown> =
    toolArgsRaw && typeof toolArgsRaw === 'object' && !Array.isArray(toolArgsRaw)
      ? (toolArgsRaw as Record<string, unknown>)
      : {};

  // ── 权限闸门 / abort ───────────────────────────────────
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return {
      ok: false,
      error: `permission denied: ${permit.reason}`,
      code: 'PERMISSION_DENIED',
      meta: buildMcpInvokeMeta({ server, tool, errorCode: 'PERMISSION_DENIED' }),
    };
  }
  if (ctx.abortSignal.aborted) {
    return {
      ok: false,
      error: 'aborted',
      code: 'ABORTED',
      meta: buildMcpInvokeMeta({ server, tool, errorCode: 'ABORTED' }),
    };
  }

  onProgress?.({ stage: 'starting', detail: `mcp ${server}.${tool}` });

  const mcpClient = getMCPClient();

  // 检查服务器是否连接（行为保真：拼出 connectedServers 列表）
  if (!mcpClient.isConnected(server)) {
    const status = mcpClient.getStatus();
    return {
      ok: false,
      error: `MCP 服务器 '${server}' 未连接。已连接的服务器: ${status.connectedServers.join(', ') || '无'}`,
      code: 'NOT_INITIALIZED',
      meta: buildMcpInvokeMeta({ server, tool, errorCode: 'NOT_INITIALIZED' }),
    };
  }

  try {
    const toolCallId = uuidv4();
    const result = await withAbort(
      mcpClient.callTool(toolCallId, server, tool, toolArgs, {
        abortSignal: ctx.abortSignal,
        sessionId: ctx.sessionId,
      }),
      ctx.abortSignal,
    );

    if (result.success) {
      const output = result.output || '执行成功';
      ctx.logger.debug('mcp done', { server, tool, ok: true });
      onProgress?.({ stage: 'completing', percent: 100 });

      // 上报 MCP 维度的 token 贡献（add 模式，按 server 名累加）
      try {
        getContextHealthService().recordSourceContribution(
          ctx.sessionId,
          { type: 'mcp', server },
          estimateTokens(output),
          'add',
        );
      } catch (err) {
        ctx.logger.debug('Failed to report MCP token contribution', { server, err });
      }

      return {
        ok: true,
        output,
        meta: buildMcpInvokeMeta({
          server,
          tool,
          output,
          duration: result.duration,
          sessionId: ctx.sessionId,
        }),
      };
    }
    ctx.logger.debug('mcp done', { server, tool, ok: false });
    const errorCode = 'DOMAIN_ERROR';
    return {
      ok: false,
      error: result.error || 'MCP 工具调用失败',
      code: errorCode,
      meta: buildMcpInvokeMeta({ server, tool, duration: result.duration, errorCode }),
    };
  } catch (error: unknown) {
    if (isAbortError(error) || ctx.abortSignal.aborted) {
      return {
        ok: false,
        error: 'aborted',
        code: 'ABORTED',
        meta: buildMcpInvokeMeta({ server, tool, errorCode: 'ABORTED' }),
      };
    }
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    return {
      ok: false,
      error: `MCP 工具调用异常: ${errorMessage}`,
      code: 'DOMAIN_ERROR',
      meta: buildMcpInvokeMeta({ server, tool, errorCode: 'DOMAIN_ERROR' }),
    };
  }
}

class McpInvokeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMcpInvoke(args, ctx, canUseTool, onProgress);
  }
}

export const mcpInvokeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpInvokeHandler();
  },
};
