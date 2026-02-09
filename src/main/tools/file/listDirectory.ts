// ============================================================================
// List Directory Tool - List directory contents
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';
import { formatFileSize } from '../network/utils';

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List the contents of a directory',
  generations: ['gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path to list. MUST be a string. ' +
          'Default: current working directory. ' +
          'Examples: "/Users/name/project", "~/Documents", "./src". ' +
          'Supports absolute paths, ~ for home, and relative paths.',
      },
      recursive: {
        type: 'boolean',
        description:
          'If true, list contents of subdirectories recursively. ' +
          'Default: false (only immediate contents). ' +
          'Auto-ignores: node_modules, .git, dist, build, .next, coverage.',
      },
      max_depth: {
        type: 'number',
        description:
          'Maximum depth for recursive listing. Integer, must be positive. ' +
          'Default: 3. Only effective when recursive=true. ' +
          'Example: max_depth=1 shows only immediate subdirectories.',
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const inputPath = (params.path as string) || context.workingDirectory;
    const recursive = (params.recursive as boolean) || false;
    const maxDepth = (params.max_depth as number) || 3;

    // Resolve path (handles ~, relative paths)
    const dirPath = resolvePath(inputPath, context.workingDirectory);

    try {
      const entries = await listDir(dirPath, recursive, maxDepth, 0);
      const output = formatEntries(entries);

      return {
        success: true,
        output,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          success: false,
          error: `Directory not found: ${dirPath}`,
        };
      }
      return {
        success: false,
        error: error.message || 'Failed to list directory',
      };
    }
  },
};

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: DirEntry[];
}

async function listDir(
  dirPath: string,
  recursive: boolean,
  maxDepth: number,
  currentDepth: number
): Promise<DirEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: DirEntry[] = [];

  // Filter out common ignored directories
  const ignoredDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];

  for (const entry of entries) {
    // Skip hidden files and ignored directories
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.isDirectory()) continue;
    }

    if (entry.isDirectory() && ignoredDirs.includes(entry.name)) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    const dirEntry: DirEntry = {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
    };

    if (!entry.isDirectory()) {
      try {
        const stats = await fs.stat(fullPath);
        dirEntry.size = stats.size;
      } catch {
        // Ignore stat errors
      }
    }

    if (entry.isDirectory() && recursive && currentDepth < maxDepth) {
      try {
        dirEntry.children = await listDir(
          fullPath,
          recursive,
          maxDepth,
          currentDepth + 1
        );
      } catch {
        // Ignore permission errors on subdirectories
      }
    }

    result.push(dirEntry);
  }

  // Sort: directories first, then files
  result.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

function formatEntries(entries: DirEntry[], indent: string = ''): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const icon = entry.isDirectory ? '📁' : '📄';
    const size = entry.size ? ` (${formatFileSize(entry.size)})` : '';
    lines.push(`${indent}${icon} ${entry.name}${size}`);

    if (entry.children && entry.children.length > 0) {
      lines.push(formatEntries(entry.children, indent + '  '));
    }
  }

  return lines.join('\n');
}

