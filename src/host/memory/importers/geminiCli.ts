import * as path from 'path';
import { instructionItem, memoryItemFromMarkdown } from './adapterHelpers';
import { listMarkdownFiles } from './markdown';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

export const geminiCliAdapter: MemoryImporterAdapter = {
  id: 'gemini-cli',
  phase: 'p1',
  async discover(options) {
    const root = path.join(options.homeDir, '.gemini');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    for (const sourcePath of await listMarkdownFiles(path.join(root, 'tmp'), true)) {
      const relative = path.relative(path.join(root, 'tmp'), sourcePath);
      if (!relative.split(path.sep).includes('memory')) continue;
      if (relative.split(path.sep).includes('.inbox') || relative.split(path.sep).includes('chats')) {
        skipped.push({ sourcePath, reason: 'unapproved-inbox-or-session' });
        continue;
      }
      if (path.basename(sourcePath).toUpperCase() === 'GEMINI.MD') {
        const rules = await instructionItem({
          adapterId: 'gemini-cli',
          sourceVendor: 'Google',
          sourcePath,
          sourceScope: relative.split(path.sep)[0] || 'project',
          verifiedOnDevice: false,
        });
        if (rules) items.push(rules);
        continue;
      }
      const item = await memoryItemFromMarkdown({
        adapterId: 'gemini-cli',
        sourceVendor: 'Google',
        sourcePath,
        sourceScope: relative.split(path.sep)[0] || 'project',
        scope: 'project',
        projectPath: null,
        verifiedOnDevice: false,
      });
      if (item) items.push(item);
    }
    const globalRules = await instructionItem({
      adapterId: 'gemini-cli',
      sourceVendor: 'Google',
      sourcePath: path.join(root, 'GEMINI.md'),
      sourceScope: 'global',
      verifiedOnDevice: false,
    });
    if (globalRules) items.push(globalRules);
    return { items, skipped };
  },
};
