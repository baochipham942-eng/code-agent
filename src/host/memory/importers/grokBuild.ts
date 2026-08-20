import * as fs from 'fs/promises';
import * as path from 'path';
import { instructionItem, memoryItemFromMarkdownContent } from './adapterHelpers';
import { directoryExists, readMarkdownFile, splitMarkdownSections } from './markdown';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

async function memoryFiles(root: string): Promise<Array<{ sourcePath: string; sourceScope: string; scope: 'global' | 'project' }>> {
  const results: Array<{ sourcePath: string; sourceScope: string; scope: 'global' | 'project' }> = [
    { sourcePath: path.join(root, 'MEMORY.md'), sourceScope: 'global', scope: 'global' },
  ];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'sessions') continue;
      results.push({
        sourcePath: path.join(root, entry.name, 'MEMORY.md'),
        sourceScope: entry.name,
        scope: 'project',
      });
    }
  } catch {
    // Empty installation is a supported state.
  }
  return results;
}

export const grokBuildAdapter: MemoryImporterAdapter = {
  id: 'grok-build',
  phase: 'p0',
  async discover(options) {
    const grokRoot = path.join(options.homeDir, '.grok');
    const memoryRoot = path.join(grokRoot, 'memory');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    if (!await directoryExists(memoryRoot)) {
      skipped.push({ sourcePath: memoryRoot, reason: 'source-not-found' });
    }
    for (const source of await memoryFiles(memoryRoot)) {
      const file = await readMarkdownFile(source.sourcePath);
      if (!file) continue;
      for (const section of splitMarkdownSections(file.raw, path.basename(path.dirname(source.sourcePath)))) {
        const item = memoryItemFromMarkdownContent({
          adapterId: 'grok-build',
          sourceVendor: 'xAI',
          sourcePath: source.sourcePath,
          sourceScope: source.sourceScope,
          sourceMtime: file.mtimeMs,
          verifiedOnDevice: true,
          scope: source.scope,
          projectPath: null,
          raw: section.content,
          fallbackTitle: section.title,
          sourceFormat: 'markdown-heading-section',
          metadata: { heading: section.title },
        });
        if (item) items.push(item);
      }
    }
    for (const sourcePath of [path.join(grokRoot, 'AGENTS.md')]) {
      const rules = await instructionItem({
        adapterId: 'grok-build',
        sourceVendor: 'xAI',
        sourcePath,
        sourceScope: 'global',
        verifiedOnDevice: true,
      });
      if (rules) items.push(rules);
    }
    return { items, skipped };
  },
};
