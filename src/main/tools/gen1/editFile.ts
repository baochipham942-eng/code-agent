// ============================================================================
// Edit File Tool - Make precise edits to files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Make precise edits to a file by replacing specific text',
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let filePath = params.file_path as string;
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) || false;

    // Resolve relative paths
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(context.workingDirectory, filePath);
    }

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
