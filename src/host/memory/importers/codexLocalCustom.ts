import * as path from 'path';
import { listMarkdownFiles } from './markdown';
import { instructionItem, memoryItemFromMarkdown } from './adapterHelpers';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

export const codexLocalCustomAdapter: MemoryImporterAdapter = {
  id: 'codex-local-custom',
  phase: 'p0',
  async discover(options) {
    const root = path.join(options.homeDir, '.codex');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    for (const sourcePath of await listMarkdownFiles(path.join(root, 'memories'))) {
      if (path.basename(sourcePath).toUpperCase() === 'MEMORY.MD') {
        skipped.push({ sourcePath, reason: 'memory-index' });
        continue;
      }
      const item = await memoryItemFromMarkdown({
        adapterId: 'codex-local-custom',
        sourceVendor: 'OpenAI',
        sourcePath,
        sourceScope: 'global',
        scope: 'global',
        verifiedOnDevice: true,
      });
      if (item) items.push(item);
    }
    const rules = await instructionItem({
      adapterId: 'codex-local-custom',
      sourceVendor: 'OpenAI',
      sourcePath: path.join(root, 'AGENTS.md'),
      sourceScope: 'global',
      verifiedOnDevice: true,
    });
    if (rules) items.push(rules);
    return { items, skipped };
  },
};
