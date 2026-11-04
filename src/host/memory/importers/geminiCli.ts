import * as path from 'path';
import { instructionItems, memoryItemFromMarkdown } from './adapterHelpers';
import { directoryExists, listMarkdownFiles } from './markdown';
import type { MemoryImporterAdapter, RawMemoryImportItem } from './types';

export const geminiCliAdapter: MemoryImporterAdapter = {
  id: 'gemini-cli',
  phase: 'p1',
  async discover(options) {
    const root = path.join(options.homeDir, '.gemini');
    const tmpRoot = path.join(root, 'tmp');
    const items: RawMemoryImportItem[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];
    if (!await directoryExists(tmpRoot)) {
      skipped.push({ sourcePath: tmpRoot, reason: 'source-not-found' });
    }
    for (const sourcePath of await listMarkdownFiles(tmpRoot, true)) {
      const relative = path.relative(tmpRoot, sourcePath);
      if (!relative.split(path.sep).includes('memory')) continue;
      if (relative.split(path.sep).includes('.inbox') || relative.split(path.sep).includes('chats')) {
        skipped.push({ sourcePath, reason: 'unapproved-inbox-or-session' });
        continue;
      }
      if (path.basename(sourcePath).toUpperCase() === 'GEMINI.MD') {
        // 项目级 GEMINI.md：整文件只供对照，不拆条（项目目录里的规则不进全局指令）
        items.push(...await instructionItems({
          adapterId: 'gemini-cli',
          sourceVendor: 'Google',
          sourcePath,
          sourceScope: relative.split(path.sep)[0] || 'project',
          verifiedOnDevice: false,
          splitRules: false,
        }));
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
    items.push(...await instructionItems({
      adapterId: 'gemini-cli',
      sourceVendor: 'Google',
      sourcePath: path.join(root, 'GEMINI.md'),
      sourceScope: 'global',
      verifiedOnDevice: false,
      splitRules: true,
    }));
    return { items, skipped };
  },
};
