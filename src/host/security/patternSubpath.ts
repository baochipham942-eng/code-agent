import path from 'node:path';

const GLOB_META = /[*?[\]]/;

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

type GlobSeg =
  | { kind: 'lit'; text: string }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'pattern'; matcher: RegExp; sample: string };

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

function segmentMatcher(segment: string): RegExp | undefined {
  let source = '^';
  let index = 0;
  while (index < segment.length) {
    const char = segment[index];
    if (char === '*') {
      source += '[^/]*';
      index += 1;
    } else if (char === '?') {
      source += '[^/]';
      index += 1;
    } else if (char === '[') {
      const end = segment.indexOf(']', index + 1);
      if (end < 0) return undefined;
      source += segment.slice(index, end + 1);
      index = end + 1;
    } else if ('.+^${}()|\\'.includes(char)) {
      source += `\\${char}`;
      index += 1;
    } else {
      source += char;
      index += 1;
    }
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    return undefined;
  }
}

function segmentSample(segment: string): string {
  let sample = '';
  let index = 0;
  while (index < segment.length) {
    const char = segment[index];
    if (char === '*') {
      sample += 'denied-child';
      index += 1;
    } else if (char === '?') {
      sample += 'x';
      index += 1;
    } else if (char === '[') {
      const end = segment.indexOf(']', index + 1);
      const body = end < 0 ? '' : segment.slice(index + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      const pick = negated ? 'x' : body.replace(/^\\/, '')[0];
      sample += pick && pick !== '-' ? pick : 'x';
      index = end < 0 ? index + 1 : end + 1;
    } else {
      sample += char;
      index += 1;
    }
  }
  return sample;
}

function globSegments(pattern: string): GlobSeg[] | undefined {
  const segments: GlobSeg[] = [];
  for (const part of pattern.split('/')) {
    if (part === '') continue;
    if (part === '**') {
      segments.push({ kind: 'globstar' });
    } else if (part === '*') {
      segments.push({ kind: 'star' });
    } else if (!GLOB_META.test(part)) {
      segments.push({ kind: 'lit', text: part });
    } else {
      const matcher = segmentMatcher(part);
      if (!matcher) return undefined;
      segments.push({ kind: 'pattern', matcher, sample: segmentSample(part) });
    }
  }
  return segments;
}

function segmentFits(segment: GlobSeg, text: string): boolean {
  if (segment.kind === 'star') return true;
  if (segment.kind === 'lit') return segment.text === text;
  if (segment.kind === 'pattern') return segment.matcher.test(text);
  return false;
}

function concreteSuffix(segments: GlobSeg[]): string[] {
  const parts: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    if (segment.kind === 'globstar') {
      if (index === segments.length - 1) parts.push('denied-child');
      continue;
    }
    if (segment.kind === 'star') parts.push('denied-child');
    else if (segment.kind === 'lit') parts.push(segment.text);
    else parts.push(segment.sample);
  }
  return parts;
}

function joinAbsolute(parts: string[]): string {
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/**
 * A wildcard above the seatbelt root still names paths inside that root.
 * Replacing `*` with a fixed token lands on a sibling, so bind those
 * wildcards to the root's own segments and continue the pattern under it.
 */
function candidatesBoundToRoot(pattern: string, root: string): string[] {
  if (!path.isAbsolute(pattern) || !GLOB_META.test(pattern)) return [];
  const patternSegments = globSegments(pattern);
  if (!patternSegments) return [];
  const rootSegments = path.resolve(root).split('/').filter((part) => part !== '');
  const found = new Set<string>();
  const seen = new Set<string>();

  const walk = (patternIndex: number, rootIndex: number): void => {
    const state = `${patternIndex}:${rootIndex}`;
    if (seen.has(state)) return;
    seen.add(state);
    if (rootIndex === rootSegments.length) {
      const rest = patternSegments.slice(patternIndex);
      const suffix = concreteSuffix(rest);
      found.add(joinAbsolute([...rootSegments, ...suffix]));
      if (suffix.length > 0 && rest.every((segment) => segment.kind === 'globstar')) {
        found.add(joinAbsolute(rootSegments));
      }
      return;
    }
    if (patternIndex >= patternSegments.length) return;
    const segment = patternSegments[patternIndex];
    const here = rootSegments[rootIndex];
    if (!segment || here === undefined) return;
    if (segment.kind === 'globstar') {
      walk(patternIndex + 1, rootIndex);
      walk(patternIndex, rootIndex + 1);
      return;
    }
    if (segmentFits(segment, here)) walk(patternIndex + 1, rootIndex + 1);
  };

  walk(0, 0);
  return [...found];
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
  const candidates = [
    ...concreteCandidates(pattern),
    ...candidatesBoundToRoot(pattern, resolvedRoot),
  ];
  for (const candidate of candidates) {
    const absoluteCandidate = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(resolvedRoot, candidate);
    if (isInside(absoluteCandidate, resolvedRoot) && matches(absoluteCandidate)) return true;
  }
  return false;
}
