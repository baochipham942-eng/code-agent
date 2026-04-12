// ============================================================================
// MemoryWrite (P0-6.3 Batch 3: native ToolModule rewrite)
//
// 旧版: src/main/lightMemory/memoryWriteTool.ts (legacy Tool + wrapLegacyTool)
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

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof VALID_TYPES)[number];

const schema: ToolSchema = {
  name: 'MemoryWrite',
  description:
    'Write, update, or delete a memory file in the persistent file-based memory system. ' +
    'Each memory is a markdown file with frontmatter (name, description, type). ' +
    'Automatically maintains INDEX.md. Use for saving user preferences, feedback, project context, or external references.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['write', 'delete'],
        description: '"write" creates or overwrites a memory file. "delete" removes it.',
      },
      filename: {
        type: 'string',
        description:
          'Memory filename (e.g., "user_role.md", "feedback_testing.md"). Must end with .md.',
      },
      name: {
        type: 'string',
        description: '[write] Memory name for frontmatter.',
      },
      description: {
        type: 'string',
        description: '[write] One-line description — used for relevance matching in INDEX.md.',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: '[write] Memory type.',
      },
      content: {
        type: 'string',
        description: '[write] The memory content (markdown body after frontmatter).',
      },
    },
    required: ['action', 'filename'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};

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

    try {
      const result =
        action === 'write'
          ? await executeWrite(args, sanitized)
          : await executeDelete(sanitized);
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
// Write
// ---------------------------------------------------------------------------
async function executeWrite(
  args: Record<string, unknown>,
  filename: string,
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

  // Build markdown with frontmatter
  const fileContent = `---
name: ${name}
description: ${description}
type: ${memType}
---

${content}
`;

  await fs.writeFile(filePath, fileContent, 'utf-8');
  await updateIndex(filename, description);

  return {
    ok: true,
    output: `Memory saved: ${filename}\n- Type: ${memType}\n- Description: ${description}`,
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function executeDelete(filename: string): Promise<ToolResult<string>> {
  const memDir = getMemoryDir();
  const filePath = path.join(memDir, filename);

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
  }

  await removeFromIndex(filename);
  return { ok: true, output: `Memory deleted: ${filename}` };
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

export const memoryWriteModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MemoryWriteHandler();
  },
};
