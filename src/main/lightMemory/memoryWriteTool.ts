// ============================================================================
// MemoryWrite Tool — Write/update/delete memory files + maintain INDEX.md
// Part of the File-as-Memory architecture. Tool code < 200 lines.
// All judgment logic lives in the prompt, not here.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/types';
import { ensureMemoryDir, getMemoryDir, getMemoryIndexPath } from './indexLoader';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryWrite');

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = typeof VALID_TYPES[number];

export const memoryWriteTool: Tool = {
  name: 'MemoryWrite',
  description:
    'Write, update, or delete a memory file in the persistent file-based memory system. ' +
    'Each memory is a markdown file with frontmatter (name, description, type). ' +
    'Automatically maintains INDEX.md. Use for saving user preferences, feedback, project context, or external references.',
  requiresPermission: false,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['write', 'delete'],
        description: '"write" creates or overwrites a memory file. "delete" removes it.',
      },
      filename: {
        type: 'string',
        description: 'Memory filename (e.g., "user_role.md", "feedback_testing.md"). Must end with .md.',
      },
      // --- write params ---
      name: {
        type: 'string',
        description: '[write] Memory name for frontmatter.',
      },
      description: {
        type: 'string',
        description: '[write] One-line description — used for relevance matching in INDEX.md.',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: '[write] Memory type.',
      },
      content: {
        type: 'string',
        description: '[write] The memory content (markdown body after frontmatter).',
      },
    },
    required: ['action', 'filename'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const filename = params.filename as string;

    if (!filename.endsWith('.md')) {
      return { success: false, error: 'Filename must end with .md' };
    }

    // Sanitize filename — no path traversal
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return { success: false, error: 'Filename must not contain path separators.' };
    }

    if (action === 'write') {
      return executeWrite(params, sanitized);
    } else if (action === 'delete') {
      return executeDelete(sanitized);
    }
    return { success: false, error: `Unknown action: "${action}". Use "write" or "delete".` };
  },
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
async function executeWrite(
  params: Record<string, unknown>,
  filename: string
): Promise<ToolExecutionResult> {
  const name = params.name as string;
  const description = params.description as string;
  const memType = params.type as string;
  const content = params.content as string;

  if (!name || !description || !memType || !content) {
    return { success: false, error: 'write action requires: name, description, type, content' };
  }

  if (!VALID_TYPES.includes(memType as MemoryType)) {
    return { success: false, error: `Invalid type: "${memType}". Must be one of: ${VALID_TYPES.join(', ')}` };
  }

  const memDir = await ensureMemoryDir();
  const filePath = path.join(memDir, filename);

  // Build markdown with frontmatter
  const fileContent = `---
name: ${name}
description: ${description}
type: ${memType}
---

${content}
`;

  try {
    await fs.writeFile(filePath, fileContent, 'utf-8');
    await updateIndex(filename, description);
    logger.info(`Memory written: ${filename} (${memType})`);

    return {
      success: true,
      output: `Memory saved: ${filename}\n- Type: ${memType}\n- Description: ${description}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write memory: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function executeDelete(filename: string): Promise<ToolExecutionResult> {
  const memDir = getMemoryDir();
  const filePath = path.join(memDir, filename);

  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { success: false, error: `Failed to delete: ${(err as Error).message}` };
    }
    // File didn't exist — still remove from index
  }

  await removeFromIndex(filename);
  logger.info(`Memory deleted: ${filename}`);
  return { success: true, output: `Memory deleted: ${filename}` };
}

// ---------------------------------------------------------------------------
// INDEX.md maintenance
// ---------------------------------------------------------------------------
async function updateIndex(filename: string, description: string): Promise<void> {
  const indexPath = getMemoryIndexPath();
  let lines: string[] = [];

  try {
    const existing = await fs.readFile(indexPath, 'utf-8');
    lines = existing.split('\n');
  } catch {
    // INDEX.md doesn't exist yet — start with header
    lines = ['# Memory Index', ''];
  }

  // Remove existing entry for this filename
  const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\]`);
  lines = lines.filter(line => !entryPattern.test(line));

  // Append new entry
  lines.push(`- [${filename}](${filename}) — ${description}`);

  await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
}

async function removeFromIndex(filename: string): Promise<void> {
  const indexPath = getMemoryIndexPath();

  try {
    const existing = await fs.readFile(indexPath, 'utf-8');
    const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\].*$`, 'gm');
    const updated = existing.replace(entryPattern, '').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(indexPath, updated, 'utf-8');
  } catch {
    // INDEX.md doesn't exist — nothing to remove
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
