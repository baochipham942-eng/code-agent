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

const schema: ToolSchema = {
  name: 'MemoryRead',
  description:
    'Read a memory detail file from the persistent file-based memory system. ' +
    'Use after checking INDEX.md (injected in system prompt) to load specific memories relevant to the current task.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Memory filename to read (e.g., "user_role.md"). Must end with .md.',
      },
    },
    required: ['filename'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

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

    const filePath = path.join(getMemoryDir(), sanitized);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('MemoryRead done', { filename: sanitized, bytes: content.length });
      return { ok: true, output: content };
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
