import * as path from 'path';
import type { MemoryEntryScope, MemoryImportAdapterId } from '../../../shared/contract/memory';
import type { RawMemoryImportItem } from './types';
import { parseImportMarkdown, readMarkdownFile } from './markdown';

export async function memoryItemFromMarkdown(input: {
  adapterId: MemoryImportAdapterId;
  sourceVendor: string;
  sourcePath: string;
  sourceScope: string;
  scope: MemoryEntryScope;
  projectPath?: string | null;
  sourceVersion?: string | null;
  verifiedOnDevice: boolean;
}): Promise<RawMemoryImportItem | null> {
  const file = await readMarkdownFile(input.sourcePath);
  if (!file) return null;
  const parsed = parseImportMarkdown(file.raw, path.basename(input.sourcePath, path.extname(input.sourcePath)));
  if (!parsed.body) return null;
  const scope = parsed.kind === 'user' || parsed.kind === 'feedback' || parsed.kind === 'directive'
    ? 'global'
    : input.scope;
  const destination = parsed.kind === 'directive' ? 'instruction' : 'memory';
  return {
    destination,
    adapterId: input.adapterId,
    sourceVendor: input.sourceVendor,
    sourceVersion: input.sourceVersion,
    sourcePath: input.sourcePath,
    sourceScope: input.sourceScope,
    sourceFormat: parsed.hasExplicitKind ? 'markdown-frontmatter' : 'markdown',
    sourceMtime: file.mtimeMs,
    verifiedOnDevice: input.verifiedOnDevice,
    title: parsed.title,
    summary: parsed.description,
    content: parsed.body,
    metadata: parsed.metadata,
    kind: parsed.kind,
    scope,
    projectPath: scope === 'project' ? input.projectPath ?? null : null,
    archived: parsed.archived,
    instructionReason: destination === 'instruction' ? 'directive-confirmation-required' : undefined,
  };
}

export async function instructionItem(input: {
  adapterId: MemoryImportAdapterId;
  sourceVendor: string;
  sourcePath: string;
  sourceScope: string;
  verifiedOnDevice: boolean;
}): Promise<RawMemoryImportItem | null> {
  const file = await readMarkdownFile(input.sourcePath);
  if (!file?.raw.trim()) return null;
  return {
    destination: 'instruction',
    adapterId: input.adapterId,
    sourceVendor: input.sourceVendor,
    sourcePath: input.sourcePath,
    sourceScope: input.sourceScope,
    sourceFormat: 'markdown-instruction',
    sourceMtime: file.mtimeMs,
    verifiedOnDevice: input.verifiedOnDevice,
    title: path.basename(input.sourcePath),
    summary: 'Instruction comparison only',
    content: file.raw.trim(),
    metadata: {},
    kind: 'directive',
    scope: 'global',
    projectPath: null,
    archived: false,
    instructionReason: 'instruction-file',
  };
}
