import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSandboxDir } from '../security/sandbox';
import type { DirectoryTreeNode, ToolDefinition } from '../types';

const DEFAULT_MAX_DEPTH = 3;
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build']);

async function walk(dir: string, maxDepth: number, currentDepth: number): Promise<DirectoryTreeNode> {
  const stats = await fs.stat(dir);
  const node: DirectoryTreeNode = {
    name: path.basename(dir),
    path: dir,
    type: 'directory',
    size: stats.size,
    children: [],
  };

  if (currentDepth >= maxDepth) {
    return node;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      node.children?.push(await walk(fullPath, maxDepth, currentDepth + 1));
      continue;
    }
    const childStats = await fs.stat(fullPath);
    node.children?.push({
      name: entry.name,
      path: fullPath,
      type: 'file',
      size: childStats.size,
    });
  }

  return node;
}

export const directoryListTool: ToolDefinition = {
  name: 'directory_list',
  permissionLevel: 'L1_READ',
  description: 'Return a directory tree.',
  async run(params, context) {
    const root = await ensureSandboxDir(
      String(params.path ?? context.config.workingDirectories[0]),
      context.config.workingDirectories
    );
    const maxDepth = Number(params.maxDepth ?? DEFAULT_MAX_DEPTH);
    const tree = await walk(root, maxDepth, 0);
    return JSON.stringify(tree, null, 2);
  },
};
