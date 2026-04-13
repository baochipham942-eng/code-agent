// ============================================================================
// Edit (multi-edit, P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/file/multiEdit.ts (registered as 'Edit')
// 复刻所有 legacy 行为：
// - file_path 必须先 Read（fileReadTracker）— 除非 force=true
// - external modification 检测
// - smart quote 标准化匹配
// - 资源锁（exclusive）
// - 原子写入
// - LSP 诊断
//
// 改造点：4 参数签名 + 不耦合 services/infra logger
// 业务依赖（lockManager/fileReadTracker/diagnostics）保留 — protocol 层只限制
// type definitions，工具模块本身可以 import 业务 helper
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { fileReadTracker } from '../../fileReadTracker';
import { checkExternalModification } from '../../utils/externalModificationDetector';
import {
  findMatchingString,
  countMatchesWithNormalization,
  replaceWithNormalization,
  containsSmartChars,
} from '../../utils/quoteNormalizer';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { getResourceLockManager } from '../../../agent/resourceLockManager';
import { getPostEditDiagnostics } from '../../lsp/diagnosticsHelper';
import { multiEditSchema as schema } from './multiEdit.schema';

interface EditOperation {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

function normalizeEdits(rawEdits: unknown): EditOperation[] | null {
  if (!Array.isArray(rawEdits)) return null;
  const result: EditOperation[] = [];
  for (const e of rawEdits) {
    if (!e || typeof e !== 'object') return null;
    const edit = e as Record<string, unknown>;
    // backward compat: old_string/new_string → old_text/new_text
    const old_text = (edit.old_text ?? edit.old_string) as string | undefined;
    const new_text = (edit.new_text ?? edit.new_string) as string | undefined;
    if (typeof old_text !== 'string' || typeof new_text !== 'string') return null;
    result.push({
      old_text,
      new_text,
      replace_all: Boolean(edit.replace_all),
    });
  }
  return result;
}

class EditHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const inputPath = args.file_path as string | undefined;
    const force = Boolean(args.force);

    if (!inputPath || typeof inputPath !== 'string') {
      return {
        ok: false,
        error: 'Missing required parameter: file_path. Provide the absolute path to the file.',
        code: 'INVALID_ARGS',
      };
    }

    const edits = normalizeEdits(args.edits);
    if (!edits || edits.length === 0) {
      return {
        ok: false,
        error: 'Missing or empty required parameter: edits. Provide an array of {old_text, new_text} objects.',
        code: 'INVALID_ARGS',
      };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const filePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(ctx.workingDir, inputPath);

    // Safety: file 必须先 Read
    if (!force && !fileReadTracker.hasBeenRead(filePath)) {
      return {
        ok: false,
        error:
          'File must be read before editing. Use Read first to view the current content, ' +
          'then make your edit. (Use force: true to bypass this check)',
        code: 'NOT_READ',
      };
    }

    onProgress?.({ stage: 'starting', detail: `edit ${path.basename(filePath)}` });

    const lockManager = getResourceLockManager();
    const holderId = ctx.sessionId || `multi_edit_${Date.now()}`;

    const lockResult = await lockManager.acquire(holderId, filePath, 'exclusive', {
      type: 'file',
      timeout: 60000,
      wait: true,
      waitTimeout: 10000,
    });

    if (!lockResult.acquired) {
      return {
        ok: false,
        error: `Cannot acquire lock for ${filePath}: ${lockResult.reason}. File may be in use by another operation.`,
        code: 'LOCK_FAILED',
      };
    }

    try {
      // Safety: external modification 检测
      if (!force && fileReadTracker.hasBeenRead(filePath)) {
        const modCheck = await checkExternalModification(filePath);
        if (modCheck.modified) {
          return {
            ok: false,
            error: `${modCheck.message}. Re-read the file to see the current content. (Use force: true to bypass)`,
            code: 'EXTERNAL_MODIFIED',
          };
        }
      }

      let content = await fs.readFile(filePath, 'utf-8');
      const originalContent = content;

      let totalReplacements = 0;
      const editResults: string[] = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldString = edit.old_text;
        const newString = edit.new_text;
        const replaceAll = edit.replace_all || false;

        let exactMatch = content.includes(oldString);
        let useNormalization = false;

        if (!exactMatch && containsSmartChars(oldString)) {
          const normalizedMatch = findMatchingString(content, oldString);
          if (normalizedMatch) {
            exactMatch = true;
            useNormalization = true;
          }
        }

        if (!exactMatch) {
          let errorMsg = `Edit #${i + 1}/${edits.length} failed: text not found.`;
          if (containsSmartChars(oldString)) {
            errorMsg += ' Smart quotes were normalized but still no match.';
          }
          if (i > 0) {
            errorMsg += ` (${i} previous edit(s) were NOT applied — all changes rolled back)`;
          }
          return { ok: false, error: errorMsg, code: 'NOT_FOUND' };
        }

        const occurrences = useNormalization
          ? countMatchesWithNormalization(content, oldString)
          : content.split(oldString).length - 1;

        if (!replaceAll && occurrences > 1) {
          let errorMsg = `Edit #${i + 1}/${edits.length} failed: found ${occurrences} occurrences. Use replace_all: true or provide more context.`;
          if (i > 0) {
            errorMsg += ` (${i} previous edit(s) were NOT applied — all changes rolled back)`;
          }
          return { ok: false, error: errorMsg, code: 'AMBIGUOUS_MATCH' };
        }

        let replacedCount: number;
        if (useNormalization) {
          const r = replaceWithNormalization(content, oldString, newString, replaceAll);
          content = r.result;
          replacedCount = r.replacedCount;
          editResults.push(
            r.wasNormalized
              ? `#${i + 1}: replaced ${replacedCount} (smart quotes normalized)`
              : `#${i + 1}: replaced ${replacedCount}`,
          );
        } else {
          if (replaceAll) {
            content = content.split(oldString).join(newString);
            replacedCount = occurrences;
          } else {
            content = content.replace(oldString, newString);
            replacedCount = 1;
          }
          editResults.push(`#${i + 1}: replaced ${replacedCount}`);
        }

        totalReplacements += replacedCount;
      }

      if (content === originalContent) {
        return {
          ok: false,
          error: 'No changes were made (all old_text values equal their new_text).',
          code: 'NO_CHANGES',
        };
      }

      await atomicWriteFile(filePath, content, 'utf-8');

      const stats = await fs.stat(filePath);
      fileReadTracker.updateAfterEdit(filePath, stats.mtimeMs, stats.size);

      const lineCount = content.split('\n').length;
      let output = `Edited ${filePath}: ${edits.length} edit(s) applied, ${totalReplacements} total replacement(s). File has ${lineCount} lines.\n`;
      output += editResults.map((r) => `  ${r}`).join('\n');

      try {
        const diagResult = await getPostEditDiagnostics(filePath);
        if (diagResult) {
          output += diagResult.formatted;
        }
      } catch {
        // diagnostic 失败不致命
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('Edit done', { filePath, edits: edits.length, totalReplacements });

      return { ok: true, output };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `File not found: ${filePath}`, code: 'ENOENT' };
      }
      return { ok: false, error: e.message ?? 'Failed to edit file', code: 'EDIT_FAILED' };
    } finally {
      lockManager.release(holderId, filePath);
    }
  }
}

export const editModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new EditHandler();
  },
};
