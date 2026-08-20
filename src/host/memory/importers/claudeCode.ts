import * as fs from 'fs/promises';
import * as path from 'path';
import { instructionItem, memoryItemFromMarkdown } from './adapterHelpers';
import { directoryExists, listMarkdownFiles } from './markdown';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

async function directories(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export const claudeCodeAdapter: MemoryImporterAdapter = {
  id: 'claude-code',
  phase: 'p0',
  async discover(options) {
    const root = path.join(options.homeDir, '.claude');
    const projectsRoot = path.join(root, 'projects');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    if (!await directoryExists(projectsRoot)) {
      skipped.push({ sourcePath: projectsRoot, reason: 'source-not-found' });
    }
    for (const projectRoot of await directories(projectsRoot)) {
      const sourceScope = path.basename(projectRoot);
      for (const sourcePath of await listMarkdownFiles(path.join(projectRoot, 'memory'), true)) {
        if (path.basename(sourcePath).toUpperCase() === 'MEMORY.MD') {
          skipped.push({ sourcePath, reason: 'memory-index' });
          continue;
        }
        const item = await memoryItemFromMarkdown({
          adapterId: 'claude-code',
          sourceVendor: 'Anthropic',
          sourcePath,
          sourceScope,
          scope: 'project',
          projectPath: null,
          verifiedOnDevice: true,
        });
        if (item) items.push(item);
      }
    }
    const rules = await instructionItem({
      adapterId: 'claude-code',
      sourceVendor: 'Anthropic',
      sourcePath: path.join(root, 'CLAUDE.md'),
      sourceScope: 'global',
      verifiedOnDevice: true,
    });
    if (rules) items.push(rules);
    return { items, skipped };
  },
};
