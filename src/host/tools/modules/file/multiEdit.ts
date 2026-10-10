// ============================================================================
// Edit (multi-edit, P0-5 Migrated to ToolModule)
//
// 旧版: src/host/tools/file/multiEdit.ts (registered as 'Edit')
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
import { computeContentDigest, fileReadTracker } from '../../fileReadTracker';
import { checkExternalModification } from '../../utils/externalModificationDetector';
import {
  findMatchingString,
  countMatchesWithNormalization,
  replaceWithNormalization,
  containsSmartChars,
} from '../../utils/quoteNormalizer';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { existingFileWriteRefusal } from '../../utils/textEncodingGuard';
import { buildNearestAnchorHint } from '../../utils/anchorHint';
import { readThenRetryHint } from '../../utils/readBeforeMutateHint';
import { findFlexibleMatch } from '../../utils/editReplacers';
import { getResourceLockManager } from '../../../services/infra/resourceLockManager';
import { getPostEditDiagnostics } from '../../lsp/diagnosticsHelper';
import { multiEditSchema as schema } from './multiEdit.schema';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { confineEvalPath } from '../../file/pathUtils';
import { getFileMutationActorId } from './fileMutationIdentity';
import { guardSkillOfficialSections } from '../../../security/skillOfficialSectionGuard';
import { resolveToolWriteTarget } from '../../../sandbox/writeFence';
import { CODE_EXTENSIONS, checkCodeCompleteness } from './write';

interface EditOperation {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

// V8 的 JSON.parse 错误消息内嵌绝对位置（"… in JSON at position 15 (line 3 column 3)"），
// 无关编辑改变错误前方内容长度后位置漂移、消息必然不同；存量问题去重前先剥掉
// 位置片段，按「错误类别 + 位置无关正文」比对，避免存量问题被误判为本次新引入。
function normalizeCompletenessIssue(issue: string): string {
  return issue.replace(/ in JSON at position \d+.*$/, '');
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
    const forceReason = typeof args.force_reason === 'string' ? args.force_reason.trim() : '';

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

    const inputFilePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(ctx.workingDir, inputPath);
    const filePath = confineEvalPath(inputFilePath, ctx.workingDir);
    const writeTarget = resolveToolWriteTarget(filePath, ctx);
    if (!writeTarget.allowed) {
      return {
        ok: false,
        error: writeTarget.reason,
        code: 'SANDBOX_WRITE_DENIED',
        meta: { outputPath: filePath },
      };
    }
    const actorId = getFileMutationActorId(ctx);
    if (!actorId) {
      return {
        ok: false,
        error: 'Edit requires a non-empty agentId to isolate concurrent file mutations.',
        code: 'MISSING_AGENT_IDENTITY',
      };
    }

    if (force && !forceReason) {
      return {
        ok: false,
        error: 'force=true requires force_reason for audit.',
        code: 'FORCE_REASON_REQUIRED',
      };
    }

    // Safety: file 必须先 Read
    if (!force && !fileReadTracker.hasBeenRead(filePath)) {
      return {
        ok: false,
        error:
          'File must be read before editing. Use Read first to view the current content, ' +
          'then make your edit. ' +
          readThenRetryHint('Edit', filePath) +
          ' (Use force: true with force_reason to bypass this check)',
        code: 'NOT_READ',
      };
    }
    const readRecord = fileReadTracker.getReadRecord(filePath);
    const forceAudit = force
      ? {
          action: 'edit_force',
          path: filePath,
          reason: forceReason,
          hadRead: Boolean(readRecord),
          readDigest: readRecord?.digest,
        }
      : undefined;
    if (forceAudit) {
      ctx.logger.warn('Edit safety overridden', forceAudit);
    }

    onProgress?.({ stage: 'starting', detail: `edit ${path.basename(filePath)}` });

    const lockManager = getResourceLockManager();
    const holderId = actorId;

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
            error: `${modCheck.message}. Re-read the file to see the current content. ${readThenRetryHint('Edit', filePath)}`,
            code: 'STALE_FILE',
            meta: {
              modification: modCheck.details,
              evidenceRef: readRecord?.evidenceRef,
            },
          };
        }
      }

      const rawContent = await fs.readFile(filePath);
      const refusal = existingFileWriteRefusal(rawContent);
      if (refusal) {
        return { ok: false, error: refusal, code: 'INVALID_ARGS', meta: { outputPath: filePath } };
      }
      let content = rawContent.toString('utf-8');
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
        // 多级 replacer 链回退（roadmap 1.1，借鉴 MiMoCode tool/edit.ts）：
        // 精确匹配与智能引号都未命中时，按 LineTrimmed → BlockAnchor →
        // IndentationFlexible 找内容中实际存在的等价子串，用它做替换。
        let effectiveOld = oldString;
        let usedFlexibleMatch = false;

        if (!exactMatch && containsSmartChars(oldString)) {
          const normalizedMatch = findMatchingString(content, oldString);
          if (normalizedMatch) {
            exactMatch = true;
            useNormalization = true;
          }
        }

        // replace_all 不走 fuzzy（codex audit R1：候选可能是其它缩进行的子串，
        // split/join 全量替换会产生缩进腐蚀），仅单点替换允许模糊回退
        if (!exactMatch && !replaceAll) {
          const flexible = findFlexibleMatch(content, oldString);
          if (flexible) {
            exactMatch = true;
            usedFlexibleMatch = true;
            effectiveOld = flexible.match;
          }
        }

        if (!exactMatch) {
          let errorMsg = `Edit #${i + 1}/${edits.length} failed: text not found.`;
          if (containsSmartChars(oldString)) {
            errorMsg += ' Smart quotes were normalized but still no match.';
          }
          const anchorHint = buildNearestAnchorHint(content, oldString);
          if (anchorHint) {
            errorMsg += anchorHint;
          }
          if (i > 0) {
            errorMsg += ` (${i} previous edit(s) were NOT applied — all changes rolled back)`;
          }
          return { ok: false, error: errorMsg, code: 'NOT_FOUND' };
        }

        const occurrences = useNormalization
          ? countMatchesWithNormalization(content, oldString)
          : content.split(effectiveOld).length - 1;

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
            content = content.split(effectiveOld).join(newString);
            replacedCount = occurrences;
          } else {
            content = content.replace(effectiveOld, newString);
            replacedCount = 1;
          }
          editResults.push(
            usedFlexibleMatch
              ? `#${i + 1}: replaced ${replacedCount} (fuzzy matched: whitespace/indentation-tolerant)`
              : `#${i + 1}: replaced ${replacedCount}`,
          );
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

      const officialSectionGuard = guardSkillOfficialSections(filePath, originalContent, content);
      if (!officialSectionGuard.allowed) {
        return {
          ok: false,
          error: officialSectionGuard.error ?? 'SKILL.md official section is protected.',
          code: officialSectionGuard.code,
        };
      }

      await atomicWriteFile(filePath, content, 'utf-8');

      const stats = await fs.stat(filePath);
      const newDigest = computeContentDigest(content);
      fileReadTracker.updateAfterEdit(filePath, stats.mtimeMs, stats.size, newDigest);

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

      // 代码完整性检测（N-EDIT-COMPLETENESS-CHECK）：Write 写完会查，Edit 之前从不查——
      // 删掉一个 JSON 逗号/HTML 闭合标签也静默通过。检测器与警告格式复用 Write 的，
      // 不回滚、不改变 ok/审批语义；只报本次编辑新引入的问题（与编辑前内容对比，
      // JSON 位置片段先归一化），存量问题不重复打扰。
      let completenessIssues: string[] | undefined;
      const ext = path.extname(filePath).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        const issues = checkCodeCompleteness(content, filePath).issues;
        if (issues.length > 0) {
          const preexisting = new Set(
            checkCodeCompleteness(originalContent, filePath).issues.map(normalizeCompletenessIssue),
          );
          const fresh = issues.filter((issue) => !preexisting.has(normalizeCompletenessIssue(issue)));
          if (fresh.length > 0) {
            completenessIssues = fresh;
            ctx.logger.warn('Code completeness check failed', { filePath, issues: fresh });
            output +=
              `\n\n⚠️ **代码完整性警告**: 检测到文件可能不完整！\n` +
              `问题:\n${fresh.map((i) => `- ${i}`).join('\n')}\n\n` +
              `**建议**: 请再次使用 Edit 工具修复以上问题，或重新生成完整文件。`;
          }
        }
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('Edit done', { filePath, edits: edits.length, totalReplacements });

      const artifact = await createFileArtifact(filePath, schema.name, ctx, {
        role: 'deliverable',
        metadata: {
          action: 'edit',
          operation: 'multi_edit',
          path: filePath,
          editCount: edits.length,
          replacementCount: totalReplacements,
          lineCount,
          ...(completenessIssues ? { completenessIssues } : {}),
          ...(forceAudit ? { audit: forceAudit } : {}),
        },
      }).catch(() => undefined);

      return {
        ok: true,
        output,
        meta: {
          action: 'edit',
          operation: 'multi_edit',
          path: filePath,
          changedFiles: [filePath],
          editCount: edits.length,
          replacementCount: totalReplacements,
          lineCount,
          edits: editResults,
          digest: newDigest,
          ...(completenessIssues ? { completenessIssues } : {}),
          ...(forceAudit ? { audit: forceAudit } : {}),
          ...(artifact ? { artifact } : {}),
        },
      };
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
