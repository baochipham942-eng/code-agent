import path from 'node:path';

const GLOB_META = /[*?[\]]/;

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function concreteCandidates(pattern: string): string[] {
  if (!GLOB_META.test(pattern)) return [pattern];
  const expanded = pattern
    .replaceAll('/**', '/denied-child')
    .replaceAll('**', 'denied-child')
    .replaceAll('*', 'denied-child')
    .replaceAll('?', 'x');
  const candidates = [expanded];
  const metaAt = pattern.search(GLOB_META);
  if (metaAt > 0) {
    const slash = pattern.lastIndexOf('/', metaAt);
    if (slash > 0) candidates.push(pattern.slice(0, slash));
  }
  return candidates;
}

/**
 * True when `pattern` matches at least one path inside `root` (root included).
 * Relative patterns are joined onto `root` so an unanchored glob is tested
 * under the seatbelt subpath, not against an unrelated prefix.
 */
export function patternIntersectsSubpath(
  pattern: string,
  root: string,
  matches: (candidate: string) => boolean,
): boolean {
  const resolvedRoot = path.resolve(root);
  for (const candidate of concreteCandidates(pattern)) {
    const absoluteCandidate = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(resolvedRoot, candidate);
    if (isInside(absoluteCandidate, resolvedRoot) && matches(absoluteCandidate)) return true;
  }
  return false;
}
