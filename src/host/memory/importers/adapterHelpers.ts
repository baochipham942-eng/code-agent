import * as path from 'path';
import type { MemoryEntryScope, MemoryImportAdapterId } from '../../../shared/contract/memory';
import type { RawMemoryImportItem } from './types';
import { contentHash, parseImportMarkdown, readMarkdownFile } from './markdown';
import { splitInstructionRules } from './instructionRuleSplit';

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
  return memoryItemFromMarkdownContent({
    ...input,
    raw: file.raw,
    sourceMtime: file.mtimeMs,
    fallbackTitle: path.basename(input.sourcePath, path.extname(input.sourcePath)),
  });
}

export function memoryItemFromMarkdownContent(input: {
  adapterId: MemoryImportAdapterId;
  sourceVendor: string;
  sourcePath: string;
  sourceScope: string;
  scope: MemoryEntryScope;
  projectPath?: string | null;
  sourceVersion?: string | null;
  verifiedOnDevice: boolean;
  raw: string;
  sourceMtime: number;
  fallbackTitle: string;
  sourceFormat?: string;
  metadata?: Record<string, unknown>;
}): RawMemoryImportItem | null {
  const parsed = parseImportMarkdown(input.raw, input.fallbackTitle);
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
    sourceFormat: input.sourceFormat || (parsed.hasExplicitKind ? 'markdown-frontmatter' : 'markdown'),
    sourceMtime: input.sourceMtime,
    verifiedOnDevice: input.verifiedOnDevice,
    title: parsed.title,
    summary: parsed.description,
    content: parsed.body,
    metadata: { ...parsed.metadata, ...input.metadata },
    kind: parsed.kind,
    scope,
    projectPath: scope === 'project' ? input.projectPath ?? null : null,
    archived: parsed.archived,
    instructionReason: destination === 'instruction' ? 'directive-confirmation-required' : undefined,
  };
}

export async function instructionItems(input: {
  adapterId: MemoryImportAdapterId;
  sourceVendor: string;
  sourcePath: string;
  sourceScope: string;
  verifiedOnDevice: boolean;
  /**
   * 用户级说明文件（~/.codex/AGENTS.md 等）拆成单条规则走确认门；项目级文件
   * 保持整文件只供对照（compare only）。拆不出规则的用户级文件也回落整文件
   * 对照项，但带 segmentCount: 0 供 UI 提示「没有可导入的单条规则」。
   */
  splitRules?: boolean;
}): Promise<RawMemoryImportItem[]> {
  const file = await readMarkdownFile(input.sourcePath);
  if (!file?.raw.trim()) return [];
  const base = {
    destination: 'instruction' as const,
    adapterId: input.adapterId,
    sourceVendor: input.sourceVendor,
    sourcePath: input.sourcePath,
    sourceScope: input.sourceScope,
    sourceFormat: 'markdown-instruction',
    sourceMtime: file.mtimeMs,
    verifiedOnDevice: input.verifiedOnDevice,
    kind: 'directive' as const,
    scope: 'global' as const,
    projectPath: null,
    archived: false,
  };
  const wholeFileItem = (metadata: Record<string, unknown>): RawMemoryImportItem => ({
    ...base,
    title: path.basename(input.sourcePath),
    summary: 'Instruction comparison only',
    content: file.raw.trim(),
    metadata,
    instructionReason: 'instruction-file',
  });
  if (!input.splitRules) return [wholeFileItem({})];

  const rules = splitInstructionRules(file.raw);
  if (rules.length === 0) return [wholeFileItem({ segmentCount: 0 })];
  const segmentOf = contentHash(file.raw.trim());
  return rules.map((rule, index): RawMemoryImportItem => ({
    ...base,
    title: rule,
    summary: `Instruction rule ${index + 1} of ${rules.length}`,
    content: rule,
    metadata: { segmentOf, segmentIndex: index, segmentCount: rules.length },
    instructionReason: 'directive-confirmation-required',
  }));
}
