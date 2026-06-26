// ============================================================================
// MemoryWrite (P0-6.3 Batch 3: native ToolModule rewrite)
//
// 旧版: src/host/lightMemory/memoryWriteTool.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger (不 import services/infra/logger)
// - 行为保真：action write/delete、frontmatter 格式、INDEX.md 自动维护、
//   path traversal 拒绝、delete 幂等（ENOENT 也更新 INDEX）
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
import {
  ensureMemoryDir,
  getMemoryDir,
  getMemoryIndexPath,
} from '../../../lightMemory/indexLoader';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';
import {
  writeScopedMemory,
  deleteScopedMemory,
  type ScopedMemoryTarget,
} from '../../../services/roleAssets/roleAssetService';

const VALID_TYPES = ['user', 'feedback', 'project', 'reference', 'skill'] as const;
type MemoryType = (typeof VALID_TYPES)[number];

// Schema lives in memoryWrite.schema.ts (P0-7 single source of truth)
// Re-import here for runtime validation (type enum check).
import { memoryWriteSchema } from './memoryWrite.schema';
const schema: ToolSchema = memoryWriteSchema;

class MemoryWriteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const action = args.action as string | undefined;
    const filename = args.filename as string | undefined;

    if (typeof filename !== 'string' || !filename) {
      return { ok: false, error: 'filename is required', code: 'INVALID_ARGS' };
    }
    if (!filename.endsWith('.md')) {
      return { ok: false, error: 'Filename must end with .md', code: 'INVALID_ARGS' };
    }

    // Sanitize filename — no path traversal
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return {
        ok: false,
        error: 'Filename must not contain path separators.',
        code: 'INVALID_ARGS',
      };
    }

    if (action !== 'write' && action !== 'delete') {
      return {
        ok: false,
        error: `Unknown action: "${action}". Use "write" or "delete".`,
        code: 'INVALID_ARGS',
      };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `${action} ${sanitized}` });

    // scope 路由（持久化角色资产三层记忆，设计 §3）：
    // global（默认）走现有 Light Memory；role/project 走 roleAssetService。
    const scope = args.scope as string | undefined;
    const scopedTarget = resolveScopedTarget(scope, ctx);
    if (scopedTarget && 'error' in scopedTarget) {
      return { ok: false, error: scopedTarget.error, code: 'INVALID_ARGS' };
    }

    try {
      const result = scopedTarget
        ? action === 'write'
          ? await executeScopedWrite(args, sanitized, scopedTarget, ctx)
          : await executeScopedDelete(sanitized, scopedTarget, ctx)
        : action === 'write'
          ? await executeWrite(args, sanitized, ctx)
          : await executeDelete(sanitized, ctx);
      onProgress?.({ stage: 'completing', percent: 100 });
      if (result.ok) {
        ctx.logger.info(`MemoryWrite ${action} done`, { filename: sanitized });
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        error: `Failed to ${action} memory: ${err instanceof Error ? err.message : 'Unknown error'}`,
        code: 'FS_ERROR',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Scoped write/delete（role / project 层，设计 §3 三层记忆）
// ---------------------------------------------------------------------------

/**
 * 解析 scope 参数到 roleAssetService 的写入目标。
 * 返回 undefined = global scope（走现有逻辑）；返回 { error } = scope 不可用。
 */
function resolveScopedTarget(
  scope: string | undefined,
  ctx: ToolContext,
): ScopedMemoryTarget | { error: string } | undefined {
  if (!scope || scope === 'global') return undefined;
  if (scope === 'role') {
    const roleId = ctx.subagent?.agentRole;
    if (!roleId) {
      return { error: 'scope "role" is only available when running as a persistent role agent' };
    }
    return { scope: 'role', roleId };
  }
  if (scope === 'project') {
    if (!ctx.workingDir) {
      return { error: 'scope "project" requires a working directory' };
    }
    return { scope: 'project', workspacePath: ctx.workingDir };
  }
  return { error: `Unknown scope: "${scope}". Use "global", "role" or "project".` };
}

async function executeScopedWrite(
  args: Record<string, unknown>,
  filename: string,
  target: ScopedMemoryTarget,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const name = args.name as string | undefined;
  const description = args.description as string | undefined;
  const content = args.content as string | undefined;

  if (!name || !description || !content) {
    return {
      ok: false,
      error: 'write action requires: name, description, content',
      code: 'INVALID_ARGS',
    };
  }

  // 写入 + 索引维护都在 roleAssetService 内完成（已带 sensitive guard）
  const filePath = await writeScopedMemory(target, { filename, name, description, content });

  const artifact = await createFileArtifact(filePath, schema.name, ctx, {
    kind: 'text',
    mimeType: 'text/markdown',
    metadata: {
      action: 'write',
      filename,
      path: filePath,
      scope: target.scope,
      description,
    },
  });

  return {
    ok: true,
    output: `Memory saved: ${filename}\n- Scope: ${target.scope}\n- Description: ${description}`,
    meta: {
      action: 'write',
      filename,
      path: filePath,
      scope: target.scope,
      description,
      artifact,
    },
  };
}

async function executeScopedDelete(
  filename: string,
  target: ScopedMemoryTarget,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const existed = await deleteScopedMemory(target, filename);
  const artifact = createVirtualArtifact({
    sourceTool: schema.name,
    kind: 'text',
    sessionId: ctx.sessionId,
    name: filename,
    mimeType: 'text/markdown',
    contentLength: 0,
    preview: `Memory deleted: ${filename}`,
    metadata: { action: 'delete', filename, scope: target.scope, existed },
  });
  return {
    ok: true,
    output: `Memory deleted: ${filename} (scope: ${target.scope})`,
    meta: { action: 'delete', filename, scope: target.scope, existed, artifact },
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
async function executeWrite(
  args: Record<string, unknown>,
  filename: string,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const name = args.name as string | undefined;
  const description = args.description as string | undefined;
  const memType = args.type as string | undefined;
  const content = args.content as string | undefined;

  if (!name || !description || !memType || !content) {
    return {
      ok: false,
      error: 'write action requires: name, description, type, content',
      code: 'INVALID_ARGS',
    };
  }

  if (!VALID_TYPES.includes(memType as MemoryType)) {
    return {
      ok: false,
      error: `Invalid type: "${memType}". Must be one of: ${VALID_TYPES.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  const memDir = await ensureMemoryDir();
  const filePath = path.join(memDir, filename);
  const existed = await exists(filePath);
  const safeName = guardMemoryText(name, 1_000);
  const safeDescription = guardMemoryText(description, 2_000);
  const safeContent = guardMemoryText(content, 50_000);

  // Build markdown with frontmatter
  const fileContent = `---
name: ${safeName}
description: ${safeDescription}
type: ${memType}
---

${safeContent}
`;

  await fs.writeFile(filePath, fileContent, 'utf-8');
  await updateIndex(filename, safeDescription);
  const artifact = await createFileArtifact(filePath, schema.name, ctx, {
    kind: 'text',
    mimeType: 'text/markdown',
    metadata: {
      action: 'write',
      filename,
      path: filePath,
      existed,
      memoryType: memType,
      description: safeDescription,
      indexPath: getMemoryIndexPath(),
    },
  });

  return {
    ok: true,
    output: `Memory saved: ${filename}\n- Type: ${memType}\n- Description: ${safeDescription}`,
    meta: {
      action: 'write',
      filename,
      path: filePath,
      existed,
      memoryType: memType,
      description: safeDescription,
      bytes: Buffer.byteLength(fileContent, 'utf8'),
      indexPath: getMemoryIndexPath(),
      artifact,
    },
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function executeDelete(filename: string, ctx: ToolContext): Promise<ToolResult<string>> {
  const memDir = getMemoryDir();
  const filePath = path.join(memDir, filename);
  let existed = true;

  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        error: `Failed to delete: ${(err as Error).message}`,
        code: 'FS_ERROR',
      };
    }
    // File didn't exist — still remove from index (idempotent)
    existed = false;
  }

  await removeFromIndex(filename);
  const artifact = createVirtualArtifact({
    sourceTool: schema.name,
    kind: 'text',
    sessionId: ctx.sessionId,
    name: filename,
    mimeType: 'text/markdown',
    contentLength: 0,
    preview: `Memory deleted: ${filename}`,
    metadata: {
      action: 'delete',
      filename,
      path: filePath,
      existed,
      indexPath: getMemoryIndexPath(),
    },
  });
  return {
    ok: true,
    output: `Memory deleted: ${filename}`,
    meta: {
      action: 'delete',
      filename,
      path: filePath,
      existed,
      indexPath: getMemoryIndexPath(),
      artifact,
    },
  };
}

// ---------------------------------------------------------------------------
// INDEX.md maintenance
// ---------------------------------------------------------------------------
async function updateIndex(filename: string, description: string): Promise<void> {
  const indexPath = getMemoryIndexPath();
  let lines: string[] = [];

  try {
    const existing = await fs.readFile(indexPath, 'utf-8');
    lines = existing.split('\n');
  } catch {
    // INDEX.md doesn't exist yet — start with header
    lines = ['# Memory Index', ''];
  }

  // Remove existing entry for this filename
  const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\]`);
  lines = lines.filter((line) => !entryPattern.test(line));

  // Append new entry
  lines.push(`- [${filename}](${filename}) — ${description}`);

  await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
}

async function removeFromIndex(filename: string): Promise<void> {
  const indexPath = getMemoryIndexPath();

  try {
    const existing = await fs.readFile(indexPath, 'utf-8');
    const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\].*$`, 'gm');
    const updated = existing.replace(entryPattern, '').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(indexPath, updated, 'utf-8');
  } catch {
    // INDEX.md doesn't exist — nothing to remove
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function guardMemoryText(value: string, maxLength: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const memoryWriteModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MemoryWriteHandler();
  },
};
