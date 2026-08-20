import * as path from 'path';
import { instructionItem, memoryItemFromMarkdown } from './adapterHelpers';
import { listMarkdownFiles } from './markdown';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

export const qwenCodeAdapter: MemoryImporterAdapter = {
  id: 'qwen-code',
  phase: 'p0',
  async discover(options) {
    const root = path.join(options.homeDir, '.qwen');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    const roots = [
      { path: path.join(root, 'memories'), scope: 'global' as const, sourceScope: 'global' },
      { path: path.join(root, 'projects'), scope: 'project' as const, sourceScope: 'projects' },
    ];
    for (const sourceRoot of roots) {
      for (const sourcePath of await listMarkdownFiles(sourceRoot.path, true)) {
        if (path.basename(sourcePath).toUpperCase() === 'MEMORY.MD') {
          skipped.push({ sourcePath, reason: 'memory-index' });
          continue;
        }
        const relative = path.relative(sourceRoot.path, sourcePath);
        const sourceScope = sourceRoot.scope === 'project' ? relative.split(path.sep)[0] || 'project' : 'global';
        const item = await memoryItemFromMarkdown({
          adapterId: 'qwen-code',
          sourceVendor: 'Alibaba',
          sourcePath,
          sourceScope,
          scope: sourceRoot.scope,
          projectPath: null,
          verifiedOnDevice: true,
        });
        if (item) items.push(item);
      }
    }
    const rules = await instructionItem({
      adapterId: 'qwen-code',
      sourceVendor: 'Alibaba',
      sourcePath: path.join(root, 'QWEN.md'),
      sourceScope: 'global',
      verifiedOnDevice: true,
    });
    if (rules) items.push(rules);
    return { items, skipped };
  },
};
