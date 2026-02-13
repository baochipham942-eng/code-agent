// ============================================================================
// Edit File Tool - Make precise edits to files
// ============================================================================
// Enhanced with:
// - File read tracking (reject edits on unread files)
// - External modification detection (warn when file changed externally)
// - Smart quote normalization (handle curly quotes from AI output)
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';
import { fileReadTracker } from '../fileReadTracker';
import { checkExternalModification } from '../utils/externalModificationDetector';
import {
  findMatchingString,
  countMatchesWithNormalization,
  replaceWithNormalization,
  containsSmartChars,
} from '../utils/quoteNormalizer';
import { atomicWriteFile } from '../utils/atomicWrite';
import { getResourceLockManager } from '../../agent/resourceLockManager';
import { getPostEditDiagnostics } from '../lsp/diagnosticsHelper';

export const editFileTool: Tool = {
  name: 'edit_file',
  description: `Make targeted text replacements in existing files. Preferred over write_file for modifying existing code.

MUST read the file with read_file first — the tool will reject edits on unread files.

How it works:
- old_string must match EXACTLY (whitespace, indentation, newlines all matter)
- old_string must be unique in the file, or use replace_all: true for all occurrences
- The line number prefixes from read_file output are NOT part of the file — do not include them

If edit fails with "text not found":
1. Re-read the file — it may have changed
2. Check indentation (tabs vs spaces) and trailing whitespace
3. Include 2-3 surrounding lines for uniqueness
4. After 2 failures, fall back to write_file to rewrite the entire file

Use replace_all: true for renaming variables/functions across the file.`,
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the file to edit. MUST be a string. ' +
          'Examples: "/Users/name/project/src/index.ts", "/home/user/config.json". ' +
          'Supports ~ for home directory. File must already exist. ' +
          'IMPORTANT: You must read this file with read_file before editing.',
      },
      old_string: {
        type: 'string',
        description:
          'The exact text to find and replace. MUST be a string. ' +
          'Must match EXACTLY including whitespace, indentation, and newlines. ' +
          'Copy directly from read_file output (excluding line number prefix). ' +
          'Include 2-3 surrounding lines for uniqueness if the text appears multiple times. ' +
          'Example: "function hello() {\\n  console.log(\\"hi\\");\\n}"',
      },
      new_string: {
        type: 'string',
        description:
          'The replacement text. MUST be a string and MUST be different from old_string. ' +
          'Preserve original indentation style (spaces vs tabs). ' +
          'To delete text, use empty string "". ' +
          'Example: "function hello() {\\n  console.log(\\"hello world\\");\\n}"',
      },
      replace_all: {
        type: 'boolean',
        description:
          'If true, replaces ALL occurrences of old_string. Default: false. ' +
          'Use for renaming variables/functions across the file. ' +
          'When false, edit fails if old_string appears more than once (provide more context).',
      },
      force: {
        type: 'boolean',
        description:
          'If true, bypasses safety checks (unread file, external modification). Default: false. ' +
          'Use with caution - this can overwrite external changes.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const inputPath = params.file_path as string;
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) || false;
    const force = (params.force as boolean) || false;

    // Parameter validation - check required params before any logic
    if (!inputPath || typeof inputPath !== 'string') {
      return {
        success: false,
        error: 'Missing required parameter: file_path. Provide the absolute path to the file.',
      };
    }

    if (oldString === undefined || oldString === null) {
      return {
        success: false,
        error:
          'Missing required parameter: old_string. ' +
          'Provide the exact text to find and replace. ' +
          'Example: {"file_path": "/path/file.txt", "old_string": "old text", "new_string": "new text"}',
      };
    }

    if (newString === undefined || newString === null) {
      return {
        success: false,
        error:
          'Missing required parameter: new_string. ' +
          'Provide the replacement text (use "" to delete). ' +
          'Example: {"file_path": "/path/file.txt", "old_string": "old text", "new_string": "new text"}',
      };
    }

    // Resolve path (handles ~, relative paths)
    // Use path.resolve() to normalize the path (same as read.ts) for consistent tracker lookup
    const filePath = path.resolve(resolvePath(inputPath, context.workingDirectory));

    // Note: Security is handled by the permission system (requiresPermission: true)
    // User will see the full path and confirm before editing

    // Safety check 1: Ensure file has been read (unless force is true)
    if (!force && !fileReadTracker.hasBeenRead(filePath)) {
      return {
        success: false,
        error:
          'File must be read before editing. Use read_file first to view the current content, ' +
          'then make your edit. This prevents accidental overwrites of content you haven\'t seen. ' +
          '(Use force: true to bypass this check)',
      };
    }

    // 获取资源锁管理器
    const lockManager = getResourceLockManager();
    const holderId = context.sessionId || `edit_${Date.now()}`;

    // 尝试获取独占锁
    const lockResult = await lockManager.acquire(holderId, filePath, 'exclusive', {
      type: 'file',
      timeout: 60000, // 锁最多持有 60 秒
      wait: true,
      waitTimeout: 10000, // 等待锁最多 10 秒
    });

    if (!lockResult.acquired) {
      return {
        success: false,
        error: `Cannot acquire lock for ${filePath}: ${lockResult.reason}. File may be in use by another operation.`,
      };
    }

    try {
      // Safety check 2: Check for external modifications (unless force is true)
      // 在锁内执行，消除时间窗口
      if (!force && fileReadTracker.hasBeenRead(filePath)) {
        const modCheck = await checkExternalModification(filePath);
        if (modCheck.modified) {
          return {
            success: false,
            error:
              `${modCheck.message}. ` +
              'Re-read the file to see the current content before editing. ' +
              '(Use force: true to bypass this check)',
          };
        }
      }

      // Read current content
      const content = await fs.readFile(filePath, 'utf-8');

      // Try exact match first
      let exactMatch = content.includes(oldString);
      let useNormalization = false;

      // If exact match fails and oldString contains smart chars, try normalized match
      if (!exactMatch && containsSmartChars(oldString)) {
        const normalizedMatch = findMatchingString(content, oldString);
        if (normalizedMatch) {
          exactMatch = true;
          useNormalization = true;
        }
      }

      if (!exactMatch) {
        // Provide helpful error message
        let errorMsg =
          'The specified text was not found in the file. Make sure old_string matches exactly.';

        if (containsSmartChars(oldString)) {
          errorMsg +=
            ' Note: Your old_string contains smart quotes or special characters. ' +
            'These were normalized but still no match was found.';
        }

        return {
          success: false,
          error: errorMsg,
        };
      }

      // Count occurrences (using normalized matching if needed)
      const occurrences = useNormalization
        ? countMatchesWithNormalization(content, oldString)
        : content.split(oldString).length - 1;

      // Check for uniqueness if not replacing all
      if (!replaceAll && occurrences > 1) {
        return {
          success: false,
          error: `Found ${occurrences} occurrences of the text. Use replace_all: true to replace all, or provide more context to make the match unique.`,
        };
      }

      // Perform replacement
      let newContent: string;
      let replacedCount: number;
      let wasNormalized = false;

      if (useNormalization) {
        // Use normalized replacement
        const result = replaceWithNormalization(
          content,
          oldString,
          newString,
          replaceAll
        );
        newContent = result.result;
        replacedCount = result.replacedCount;
        wasNormalized = result.wasNormalized;
      } else {
        // Use standard replacement
        if (replaceAll) {
          newContent = content.split(oldString).join(newString);
          replacedCount = occurrences;
        } else {
          newContent = content.replace(oldString, newString);
          replacedCount = 1;
        }
      }

      // Check if anything changed
      if (newContent === content) {
        return {
          success: false,
          error: 'No changes were made (old_string equals new_string)',
        };
      }

      // 使用原子写入（temp + rename 模式）
      await atomicWriteFile(filePath, newContent, 'utf-8');

      // 提取编辑位置周围的代码片段
      const N_LINES_SNIPPET = 4;
      let snippet = '';
      try {
        const lines = newContent.split('\n');
        const newStringFirstLine = newString.split('\n')[0];
        const editLineIndex = lines.findIndex(line => line.includes(newStringFirstLine));
        if (editLineIndex >= 0) {
          const start = Math.max(0, editLineIndex - N_LINES_SNIPPET);
          const end = Math.min(lines.length, editLineIndex + newString.split('\n').length + N_LINES_SNIPPET);
          snippet = lines
            .slice(start, end)
            .map((line, i) => `${start + i + 1}\t${line}`)
            .join('\n');
        }
      } catch {
        // snippet 生成失败不影响主流程
      }

      // Update the file read tracker with new mtime
      const stats = await fs.stat(filePath);
      fileReadTracker.updateAfterEdit(filePath, stats.mtimeMs, stats.size);

      // Build output message
      let output = `Edited ${filePath}: replaced ${replacedCount} occurrence(s)`;
      if (wasNormalized) {
        output += ' (smart quotes were normalized to match)';
      }
      if (snippet) {
        output += `\n\n${snippet}`;
      }

      // LSP 诊断闭环：编辑后自动查询 LSP 诊断
      try {
        const diagResult = await getPostEditDiagnostics(filePath);
        if (diagResult) {
          output += diagResult.formatted;
        }
      } catch {
        // 诊断失败不影响编辑结果
      }

      return {
        success: true,
        output,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }
      return {
        success: false,
        error: error.message || 'Failed to edit file',
      };
    } finally {
      // 释放锁
      lockManager.release(holderId, filePath);
    }
  },
};
