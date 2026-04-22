// ============================================================================
// csvSort - comparator used by CsvTable.
// Separated into its own module so it can be unit-tested without pulling in
// papaparse / React.
// ============================================================================

/**
 * Compares two unknown values as if they were CSV cells.
 *
 * - If both sides parse as finite numbers and neither is empty, compares
 *   numerically so "9" sorts before "10".
 * - Otherwise falls back to locale-aware string compare.
 * - Null / undefined are treated as empty strings, which sort before anything
 *   non-empty.
 */
export function compareCsvCells(a: unknown, b: unknown): number {
  const aStr = a == null ? '' : String(a);
  const bStr = b == null ? '' : String(b);
  const aNum = Number(aStr);
  const bNum = Number(bStr);
  const bothNumeric = !Number.isNaN(aNum) && !Number.isNaN(bNum) && aStr !== '' && bStr !== '';
  if (bothNumeric) return aNum - bNum;
  return aStr.localeCompare(bStr);
}
