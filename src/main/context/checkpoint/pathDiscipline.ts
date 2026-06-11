import path from 'path';

export interface CheckpointPathTable {
  CHECKPOINT_PATH: string;
  MEMORY_PATH: string;
  TASK_MEM_DIR: string;
  NOTES_PATH?: string;
}

export interface PathDisciplineViolation {
  path: string;
  reason: string;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function buildAllowedPaths(table: CheckpointPathTable): Set<string> {
  return new Set(
    [table.CHECKPOINT_PATH, table.MEMORY_PATH, table.TASK_MEM_DIR, table.NOTES_PATH]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map(normalizePath),
  );
}

function isAllowedTaskPath(candidate: string, table: CheckpointPathTable): boolean {
  const taskDir = normalizePath(table.TASK_MEM_DIR);
  return candidate === taskDir || candidate.startsWith(`${taskDir}${path.sep}`);
}

function findLiteralRanges(content: string, literals: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const literal of literals) {
    if (!literal) continue;
    let index = content.indexOf(literal);
    while (index !== -1) {
      ranges.push({ start: index, end: index + literal.length });
      index = content.indexOf(literal, index + literal.length);
    }
  }
  return ranges;
}

function isInRanges(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function validatePathDiscipline(
  content: string,
  table: CheckpointPathTable,
  options: { allowExactLiterals?: string[] } = {},
): { valid: boolean; violations: PathDisciplineViolation[] } {
  const allowed = buildAllowedPaths(table);
  const exactRanges = findLiteralRanges(content, options.allowExactLiterals ?? []);
  const violations: PathDisciplineViolation[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(/(?:^|[\s("'`])((?:\/[A-Za-z0-9._@%+,:=-]+)+\/?)/g)) {
    const raw = match[1].replace(/[.,;:!?]+$/, '');
    const start = (match.index ?? 0) + match[0].indexOf(match[1]);
    if (isInRanges(start, exactRanges)) continue;
    const normalized = normalizePath(raw);
    if (allowed.has(normalized) || isAllowedTaskPath(normalized, table)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    violations.push({
      path: raw,
      reason: 'absolute path is not present in the checkpoint writer path table',
    });
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

