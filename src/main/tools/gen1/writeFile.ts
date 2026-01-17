// ============================================================================
// Write File Tool - Create or overwrite files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create a new file or overwrite an existing file',
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let filePath = params.file_path as string;
    const content = params.content as string;

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
        error: 'Cannot write files outside the working directory',
      };
    }

    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Check if file exists (for reporting)
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        // File doesn't exist, that's fine
      }

      // Write file
      await fs.writeFile(filePath, content, 'utf-8');

      const action = existed ? 'Updated' : 'Created';
      return {
        success: true,
        output: `${action} file: ${filePath} (${content.length} bytes)`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to write file',
      };
    }
  },
};
