import * as Diff from 'diff';

export type DiffLineChange = ReturnType<typeof Diff.diffLines>[number];

function getNonEmptyLines(value: string): string[] {
  return value.split('\n').filter((line) => line !== '');
}

export function hasCommonNonEmptyLine(oldText: string, newText: string): boolean {
  const oldLines = getNonEmptyLines(oldText);
  if (oldLines.length === 0) return false;

  const oldLineSet = new Set(oldLines);
  for (const line of getNonEmptyLines(newText)) {
    if (oldLineSet.has(line)) return true;
  }
  return false;
}

export function diffLinesWithFastPath(oldText: string, newText: string): DiffLineChange[] {
  if (oldText === newText) {
    return oldText
      ? [{ value: oldText, count: getNonEmptyLines(oldText).length, added: false, removed: false }]
      : [];
  }

  if (!hasCommonNonEmptyLine(oldText, newText)) {
    const changes: DiffLineChange[] = [];
    if (oldText) {
      changes.push({
        value: oldText,
        count: getNonEmptyLines(oldText).length,
        added: false,
        removed: true,
      });
    }
    if (newText) {
      changes.push({
        value: newText,
        count: getNonEmptyLines(newText).length,
        added: true,
        removed: false,
      });
    }
    return changes;
  }

  return Diff.diffLines(oldText, newText);
}
