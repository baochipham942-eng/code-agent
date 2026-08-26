import type { ListRange } from 'react-virtuoso';

export function isTurnVisibleInRange(
  range: ListRange,
  turnIndex: number,
  firstItemIndex: number,
): boolean {
  if (turnIndex < 0) return false;
  const absoluteIndex = firstItemIndex + turnIndex;
  return absoluteIndex >= range.startIndex && absoluteIndex <= range.endIndex;
}
