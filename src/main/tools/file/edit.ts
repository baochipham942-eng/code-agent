// ============================================================================
// Edit File Tool - Make precise edits to files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';

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

    // Resolve path (handles ~, relative paths)
    const filePath = resolvePath(inputPath, context.workingDirectory);

    // Security check: ensure file is within working directory
    const resolvedPath = path.resolve(filePath);
    const resolvedWorkingDir = path.resolve(context.workingDirectory);

    if (!resolvedPath.startsWith(resolvedWorkingDir)) {
      return {
        success: false,
        error: 'Cannot edit files outside the working directory',
      };
    }

    try {
      // Read current content
      const content = await fs.readFile(filePath, 'utf-8');

      // Check if old_string exists
      if (!content.includes(oldString)) {
        return {
          success: false,
          error: `The specified text was not found in the file. Make sure old_string matches exactly.`,
        };
      }

      // Count occurrences
      const occurrences = content.split(oldString).length - 1;

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

      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
        replacedCount = occurrences;
      } else {
        newContent = content.replace(oldString, newString);
        replacedCount = 1;
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

      return {
        success: true,
        output: `Edited ${filePath}: replaced ${replacedCount} occurrence(s)`,
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
