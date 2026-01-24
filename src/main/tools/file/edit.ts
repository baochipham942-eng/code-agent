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

export const editFileTool: Tool = {
  name: 'edit_file',
  description: `Perform exact string replacements in files.

CRITICAL: You MUST read the file with read_file before editing.
This tool will fail if you attempt an edit without reading the file first.

Usage:
- old_string: The exact text to replace (must be UNIQUE in the file unless using replace_all)
- new_string: The replacement text (must be different from old_string)
- replace_all: Set to true to replace all occurrences of old_string

When editing text from read_file output:
- Preserve the EXACT indentation (tabs/spaces) as shown in the file content
- The line number prefix from read_file is NOT part of the file content
- Match whitespace exactly - trailing spaces and newlines matter

Common errors and solutions:
- "text not found": Your old_string doesn't match exactly - check whitespace and indentation
- "multiple occurrences": Provide more surrounding context to make old_string unique, or use replace_all: true

Best practices:
- Include 2-3 lines of surrounding context in old_string for uniqueness
- Use replace_all for renaming variables/functions across the file
- For large changes, make multiple smaller edits instead of one huge replacement`,
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
    const filePath = resolvePath(inputPath, context.workingDirectory);

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

    // Safety check 2: Check for external modifications (unless force is true)
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

    try {
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

      // Write back
      await fs.writeFile(filePath, newContent, 'utf-8');

      // Update the file read tracker with new mtime
      const stats = await fs.stat(filePath);
      fileReadTracker.updateAfterEdit(filePath, stats.mtimeMs, stats.size);

      // Build output message
      let output = `Edited ${filePath}: replaced ${replacedCount} occurrence(s)`;
      if (wasNormalized) {
        output += ' (smart quotes were normalized to match)';
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
    }
  },
};
