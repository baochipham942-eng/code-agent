import path from 'node:path';
import type {
  CompactionSurvivorFile,
  CompactionSurvivorItem,
  CompactionSurvivorManifest,
} from '../../shared/contract';

export type CompactionSummaryManifest = CompactionSurvivorManifest;
export type CompactionSummaryManifestFile = CompactionSurvivorFile;
export type CompactionSummaryManifestItem = CompactionSurvivorItem;

export interface CompactionSummaryValidation {
  ok: boolean;
  missingPaths: string[];
  missingErrors: string[];
  missingOpenWork: string[];
  warnings: string[];
}

const NEEDS_RE_READ_PATTERN =
  /\bneeds?\s+(?:to\s+be\s+)?(?:re[- ]?read|read\s+again)\b|\bre[- ]?read\b|\brevisit\b|需要(?:重新读|回读)|需(?:重新读|回读)|要(?:重新读|回读)|重新读|回读/i;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function includesText(summary: string, expected: string): boolean {
  const normalizedExpected = normalizeText(expected);
  if (!normalizedExpected) return true;
  return normalizeText(summary).includes(normalizedExpected);
}

function basenameNeedsReRead(summary: string, filePath: string): boolean {
  const basename = path.basename(filePath);
  if (!basename || !includesText(summary, basename)) return false;

  const normalizedSummary = normalizeText(summary);
  const normalizedBasename = normalizeText(basename);
  const start = normalizedSummary.indexOf(normalizedBasename);
  if (start < 0) return false;

  const windowStart = Math.max(0, start - 120);
  const windowEnd = Math.min(normalizedSummary.length, start + normalizedBasename.length + 120);
  return NEEDS_RE_READ_PATTERN.test(normalizedSummary.slice(windowStart, windowEnd));
}

function itemText(item: Pick<CompactionSurvivorItem, 'label' | 'detail'>): string {
  return [item.label, item.detail].filter(Boolean).join(': ');
}

function itemCovered(summary: string, item: Pick<CompactionSurvivorItem, 'label' | 'detail'>): boolean {
  const candidates = [item.label, item.detail, itemText(item)].filter((value): value is string => Boolean(value?.trim()));
  if (candidates.length === 0) return true;
  return candidates.some(candidate => includesText(summary, candidate));
}

function unresolvedErrors(manifest: CompactionSummaryManifest): CompactionSurvivorItem[] {
  return (manifest.errors ?? []).filter(error => (error as { resolved?: boolean }).resolved !== true);
}

export function validateCompactionSummary(
  summary: string,
  manifest: CompactionSummaryManifest
): CompactionSummaryValidation {
  const missingPaths: string[] = [];
  const missingErrors: string[] = [];
  const missingOpenWork: string[] = [];
  const warnings: string[] = [];

  for (const file of manifest.files ?? []) {
    if (!file.path) continue;
    if (summary.includes(file.path)) continue;

    if (basenameNeedsReRead(summary, file.path)) {
      warnings.push(`Path ${file.path} was covered only by basename with needs re-read instruction.`);
      continue;
    }

    missingPaths.push(file.path);
  }

  for (const error of unresolvedErrors(manifest)) {
    if (!itemCovered(summary, error)) {
      missingErrors.push(itemText(error));
    }
  }

  for (const work of manifest.openWork ?? []) {
    if (!itemCovered(summary, work)) {
      missingOpenWork.push(itemText(work));
    }
  }

  return {
    ok: missingPaths.length === 0 && missingErrors.length === 0 && missingOpenWork.length === 0,
    missingPaths,
    missingErrors,
    missingOpenWork,
    warnings,
  };
}

export function buildSummaryRepairInstruction(validation: CompactionSummaryValidation): string {
  if (validation.ok) {
    return 'The compaction summary covers the survivor manifest. No repair is needed.';
  }

  const sections: string[] = [
    'Repair the compaction summary by adding the survivor manifest items that were missed.',
  ];

  if (validation.missingPaths.length > 0) {
    sections.push([
      'Missing file paths:',
      ...validation.missingPaths.map(item => `- ${item}`),
    ].join('\n'));
  }

  if (validation.missingErrors.length > 0) {
    sections.push([
      'Missing unresolved errors:',
      ...validation.missingErrors.map(item => `- ${item}`),
    ].join('\n'));
  }

  if (validation.missingOpenWork.length > 0) {
    sections.push([
      'Missing open work:',
      ...validation.missingOpenWork.map(item => `- ${item}`),
    ].join('\n'));
  }

  return sections.join('\n\n');
}
