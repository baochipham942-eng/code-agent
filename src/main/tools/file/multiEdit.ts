// ============================================================================
// Multi Edit File Tool - Apply multiple edits to a single file in one call
// ============================================================================
// Allows batching multiple edit operations on the same file, reducing
// round-trips and ensuring atomic application of related changes.
// Reuses the same safety infrastructure as Edit:
// - File read tracking, external modification detection
// - Smart quote normalization, atomic write, resource locks
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';
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

interface EditOperation {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

export const multiEditFileTool: Tool = {
  name: 'Edit',
  description: `Apply multiple text replacements to the same file in a single operation. Use this instead of calling Edit repeatedly on the same file.

MUST read the file with Read first — the tool will reject edits on unread files.

How it works:
- Each edit in the edits array works like Edit: old_text must match EXACTLY
- Edits are applied sequentially — each edit operates on the result of the previous one
- If any edit fails (text not found, ambiguous match), all changes are rolled back (no partial writes)
- old_text values should reflect the ORIGINAL file content; but if earlier edits change a region, later edits must account for that

When to use:
- Renaming + updating references in the same file
- Multiple independent changes to the same file
- Refactoring that touches several locations in one file

Tips:
- Order edits from bottom to top of the file to avoid line-shift issues (optional but recommended)
- Each old_text must be unique in the content at the time it is applied (or use replace_all: true)`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the file to edit. MUST be a string. ' +
          'Supports ~ for home directory. File must already exist. ' +
          'IMPORTANT: You must read this file with Read before editing.',
      },
      edits: {
        type: 'array',
        description:
          'Array of edit operations to apply sequentially. Each edit has old_text, new_text, and optional replace_all.',
        items: {
          type: 'object',
          properties: {
            old_text: {
              type: 'string',
              description: 'The exact text to find and replace.',
            },
            new_text: {
              type: 'string',
              description: 'The replacement text. Use "" to delete.',
            },
            replace_all: {
              type: 'boolean',
              description: 'If true, replaces ALL occurrences. Default: false.',
            },
          },
          required: ['old_text', 'new_text'],
        },
      },
      force: {
        type: 'boolean',
        description:
          'If true, bypasses safety checks (unread file, external modification). Default: false.',
      },
    },
    required: ['file_path', 'edits'],
  },

  async execute(
    rawParams: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    // Backward compat: accept legacy parameter names (old_string/new_string)
    const params = { ...rawParams };
    if (Array.isArray(params.edits)) {
      params.edits = (params.edits as Record<string, unknown>[]).map(e => {
        const edit = { ...e };
        if (edit['old_string'] !== undefined && edit.old_text === undefined) edit.old_text = edit['old_string'];
        if (edit['new_string'] !== undefined && edit.new_text === undefined) edit.new_text = edit['new_string'];
        return edit;
      });
    }

    const inputPath = params.file_path as string;
    const edits = params.edits as EditOperation[] | undefined;
    const force = (params.force as boolean) || false;

    // --- Parameter validation ---
    if (!inputPath || typeof inputPath !== 'string') {
      return {
        success: false,
        error: 'Missing required parameter: file_path. Provide the absolute path to the file.',
      };
    }

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return {
        success: false,
        error:
          'Missing or empty required parameter: edits. ' +
          'Provide an array of {old_text, new_text} objects.',
      };
    }

    // Validate each edit entry
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      if (edit.old_text === undefined || edit.old_text === null) {
        return {
          success: false,
          error: `Edit #${i + 1}: missing old_text.`,
        };
      }
      if (edit.new_text === undefined || edit.new_text === null) {
        return {
          success: false,
          error: `Edit #${i + 1}: missing new_text.`,
        };
      }
    }

    // Resolve path
    const filePath = path.resolve(resolvePath(inputPath, context.workingDirectory));

    // Safety check 1: Ensure file has been read
    if (!force && !fileReadTracker.hasBeenRead(filePath)) {
      return {
        success: false,
        error:
          'File must be read before editing. Use Read first to view the current content, ' +
          'then make your edit. This prevents accidental overwrites of content you haven\'t seen. ' +
          '(Use force: true to bypass this check)',
      };
    }

    // Acquire resource lock
    const lockManager = getResourceLockManager();
    const holderId = context.sessionId || `multi_edit_${Date.now()}`;

    const lockResult = await lockManager.acquire(holderId, filePath, 'exclusive', {
      type: 'file',
      timeout: 60000,
      wait: true,
      waitTimeout: 10000,
    });

    if (!lockResult.acquired) {
      return {
        success: false,
        error: `Cannot acquire lock for ${filePath}: ${lockResult.reason}. File may be in use by another operation.`,
      };
    }

    try {
      // Safety check 2: External modification detection
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

      // Read current content once
      let content = await fs.readFile(filePath, 'utf-8');
      const originalContent = content;

      // Apply edits sequentially
      let totalReplacements = 0;
      const editResults: string[] = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldString = edit.old_text;
        const newString = edit.new_text;
        const replaceAll = edit.replace_all || false;

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
          // Roll back: do not write anything
          let errorMsg = `Edit #${i + 1}/${edits.length} failed: text not found.`;
          if (containsSmartChars(oldString)) {
            errorMsg += ' Smart quotes were normalized but still no match.';
          }
          if (i > 0) {
            errorMsg += ` (${i} previous edit(s) were NOT applied — all changes rolled back)`;
          }
          return {
            success: false,
            error: errorMsg,
          };
        }

        // Count occurrences
        const occurrences = useNormalization
          ? countMatchesWithNormalization(content, oldString)
          : content.split(oldString).length - 1;

        // Uniqueness check
        if (!replaceAll && occurrences > 1) {
          let errorMsg = `Edit #${i + 1}/${edits.length} failed: found ${occurrences} occurrences. Use replace_all: true or provide more context.`;
          if (i > 0) {
            errorMsg += ` (${i} previous edit(s) were NOT applied — all changes rolled back)`;
          }
          return {
            success: false,
            error: errorMsg,
          };
        }

        // Perform replacement
        let replacedCount: number;

        if (useNormalization) {
          const result = replaceWithNormalization(content, oldString, newString, replaceAll);
          content = result.result;
          replacedCount = result.replacedCount;
          if (result.wasNormalized) {
            editResults.push(`#${i + 1}: replaced ${replacedCount} (smart quotes normalized)`);
          } else {
            editResults.push(`#${i + 1}: replaced ${replacedCount}`);
          }
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

      // Check if anything changed overall
      if (content === originalContent) {
        return {
          success: false,
          error: 'No changes were made (all old_text values equal their new_text).',
        };
      }

      // Atomic write once
      await atomicWriteFile(filePath, content, 'utf-8');

      // Update file read tracker
      const stats = await fs.stat(filePath);
      fileReadTracker.updateAfterEdit(filePath, stats.mtimeMs, stats.size);

      // Build output
      const lineCount = content.split('\n').length;
      let output = `Edited ${filePath}: ${edits.length} edit(s) applied, ${totalReplacements} total replacement(s). File has ${lineCount} lines.\n`;
      output += editResults.map(r => `  ${r}`).join('\n');

      // LSP diagnostics
      try {
        const diagResult = await getPostEditDiagnostics(filePath);
        if (diagResult) {
          output += diagResult.formatted;
        }
      } catch {
        // Diagnostics failure should not affect edit result
      }

      return {
        success: true,
        output,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if ((error as Record<string, unknown>).code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }
      return {
        success: false,
        error: errMsg || 'Failed to edit file',
      };
    } finally {
      lockManager.release(holderId, filePath);
    }
  },
};
