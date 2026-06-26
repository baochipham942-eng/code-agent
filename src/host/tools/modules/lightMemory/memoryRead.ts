// ============================================================================
// MemoryRead (P0-6.3 Batch 3: native ToolModule rewrite)
//
// 旧版: src/main/lightMemory/memoryReadTool.ts (legacy Tool 接口 + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger (不 import services/infra/logger)
// - 行为保真：filename 必须 .md / 禁路径穿越 / ENOENT 明确错误 / 读 getMemoryDir()
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getMemoryDir } from '../../../lightMemory/indexLoader';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { guardSensitiveTextAsync } from '../../../security/sensitiveDataGuard';
import { getRoleMemoriesDir, getProjectMemoriesDir } from '../../../services/roleAssets/roleAssetPaths';

// Schema lives in memoryRead.schema.ts (P0-7 single source of truth)
import { memoryReadSchema } from './memoryRead.schema';
const schema: ToolSchema = memoryReadSchema;

/**
 * 按 scope 解析记忆目录（持久化角色资产三层记忆，设计 §3）：
 * - global（默认）：~/.code-agent/memory/（现有 Light Memory）
 * - role：roles/<roleId>/memories/，roleId 来自 ctx.subagent.agentRole
 * - project：projects/<hash>/memory/memories/，key 来自 ctx.workingDir
 * 返回 null 表示该 scope 在当前上下文不可用（如非持久角色请求 role scope）。
 */
function resolveScopedMemoryDir(scope: string | undefined, ctx: ToolContext): { dir: string } | { error: string } {
  if (!scope || scope === 'global') {
    return { dir: getMemoryDir() };
  }
  if (scope === 'role') {
    const roleId = ctx.subagent?.agentRole;
    if (!roleId) {
      return { error: 'scope "role" is only available when running as a persistent role agent' };
    }
    try {
      return { dir: getRoleMemoriesDir(roleId) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (scope === 'project') {
    if (!ctx.workingDir) {
      return { error: 'scope "project" requires a working directory' };
    }
    return { dir: getProjectMemoriesDir(ctx.workingDir) };
  }
  return { error: `Unknown scope: "${scope}". Use "global", "role" or "project".` };
}

class MemoryReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const filename = args.filename as string | undefined;

    if (typeof filename !== 'string' || !filename) {
      return { ok: false, error: 'filename is required', code: 'INVALID_ARGS' };
    }

    if (!filename.endsWith('.md')) {
      return { ok: false, error: 'Filename must end with .md', code: 'INVALID_ARGS' };
    }

    // Sanitize — no path traversal
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return { ok: false, error: 'Filename must not contain path separators.', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `read ${sanitized}` });

    // scope 路由（global / role / project 三层记忆）
    const scope = args.scope as string | undefined;
    const resolved = resolveScopedMemoryDir(scope, ctx);
    if ('error' in resolved) {
      return { ok: false, error: resolved.error, code: 'INVALID_ARGS' };
    }
    const filePath = path.join(resolved.dir, sanitized);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const safeContent = await guardSensitiveTextAsync(content, {
        surface: 'memory',
        mode: 'model-context',
        maxLength: 50_000,
      });
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('MemoryRead done', { filename: sanitized, bytes: content.length });
      const artifact = await createFileArtifact(filePath, schema.name, ctx, {
        kind: 'text',
        mimeType: 'text/markdown',
        metadata: {
          filename: sanitized,
          memoryDir: resolved.dir,
          scope: scope || 'global',
          bytes: Buffer.byteLength(content, 'utf8'),
        },
      });
      return {
        ok: true,
        output: safeContent,
        meta: {
          filename: sanitized,
          path: filePath,
          scope: scope || 'global',
          bytes: Buffer.byteLength(content, 'utf8'),
          artifact,
        },
      };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `Memory file not found: ${sanitized}`, code: 'ENOENT' };
      }
      return {
        ok: false,
        error: `Failed to read memory: ${e.message ?? 'Unknown error'}`,
        code: 'FS_ERROR',
      };
    }
  }
}

export const memoryReadModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MemoryReadHandler();
  },
};
