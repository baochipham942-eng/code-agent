// ============================================================================
// MemoryRead Tool — Read memory detail files on demand
// Part of the File-as-Memory architecture.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/types';
import { getMemoryDir } from './indexLoader';

export const memoryReadTool: Tool = {
  name: 'MemoryRead',
  description:
    'Read a memory detail file from the persistent file-based memory system. ' +
    'Use after checking INDEX.md (injected in system prompt) to load specific memories relevant to the current task.',
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const filename = params.filename as string;

    if (!filename.endsWith('.md')) {
      return { success: false, error: 'Filename must end with .md' };
    }

    // Sanitize — no path traversal
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return { success: false, error: 'Filename must not contain path separators.' };
    }

    const filePath = path.join(getMemoryDir(), sanitized);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, output: content };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `Memory file not found: ${sanitized}` };
      }
      return {
        success: false,
        error: `Failed to read memory: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  },
};
