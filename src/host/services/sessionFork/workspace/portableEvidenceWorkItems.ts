import type { AnchorWorkspaceEvidence } from './types';

type PortableEvidenceFileSource = 'staged-patch' | 'unstaged-patch' | 'untracked';

interface PortableEvidencePatchWorkItem {
  kind: 'patch';
  path: string;
  source: PortableEvidenceFileSource;
  sections: Buffer[];
}

interface PortableEvidenceUntrackedWorkItem {
  kind: 'untracked';
  path: string;
  source: 'untracked';
  bytes: Buffer;
  mode: number;
}

export type PortableEvidenceWorkItem =
  | PortableEvidencePatchWorkItem
  | PortableEvidenceUntrackedWorkItem;

export interface PortableEvidenceInvalidSection {
  label: string;
  source: PortableEvidenceFileSource;
  reason: string;
}

const DIFF_HEADER = 'diff --git ';

/** Splits a `git diff` stream into per-file sections without re-encoding bytes. */
function splitPatchSections(patch: Buffer): Buffer[] {
  if (patch.byteLength === 0) return [];
  const starts: number[] = [];
  if (patch.subarray(0, DIFF_HEADER.length).toString('utf8') === DIFF_HEADER) starts.push(0);
  let newline = patch.indexOf('\n');
  while (newline !== -1) {
    const lineStart = newline + 1;
    if (patch.subarray(lineStart, lineStart + DIFF_HEADER.length).toString('utf8') === DIFF_HEADER) {
      starts.push(lineStart);
    }
    newline = patch.indexOf('\n', lineStart);
  }
  if (starts.length === 0) return [patch];
  const bounds = [...starts, patch.byteLength];
  return starts.map((start, index) => patch.subarray(start, bounds[index + 1]));
}

/**
 * Decodes a C-quoted `diff --git` header path. Git's default quotepath escapes
 * non-ASCII bytes as octal, so escapes must accumulate as raw bytes and decode
 * as UTF-8; one code unit per byte would turn every non-ASCII path into
 * mojibake that no resolution or write target can match.
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  let value = '';
  let octets: number[] = [];
  let index = start + 1;
  const flushOctets = (): void => {
    if (octets.length > 0) {
      value += Buffer.from(octets).toString('utf8');
      octets = [];
    }
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      flushOctets();
      return { value, end: index + 1 };
    }
    if (char !== '\\') {
      flushOctets();
      value += char;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) return null;
    if (escape === 'n') {
      flushOctets();
      value += '\n';
    } else if (escape === 't') {
      flushOctets();
      value += '\t';
    } else if (escape === 'r') {
      flushOctets();
      value += '\r';
    } else if (escape >= '0' && escape <= '7') {
      const octal = /^[0-7]{1,3}/u.exec(text.slice(index + 1, index + 4));
      if (!octal) return null;
      octets.push(parseInt(octal[0], 8));
      index += octal[0].length + 1;
      continue;
    } else {
      flushOctets();
      value += escape;
    }
    index += 2;
  }
  return null;
}

/** Extracts the b-side (post-patch) repository path from a `diff --git` header. */
function parsePatchPath(section: Buffer): string | null {
  const lineEnd = section.indexOf('\n');
  const header = section.subarray(0, lineEnd === -1 ? section.byteLength : lineEnd).toString('utf8');
  if (!header.startsWith(DIFF_HEADER)) return null;
  const rest = header.slice(DIFF_HEADER.length);
  if (!rest.startsWith('"')) {
    const separator = rest.indexOf(' b/');
    if (separator === -1) return null;
    const raw = rest.slice(separator + 3);
    return raw && !raw.startsWith('"') ? raw : null;
  }
  const first = readQuoted(rest, 0);
  if (first === null) return null;
  if (rest[first.end] !== ' ') return null;
  const second = readQuoted(rest, first.end + 1);
  if (second?.end !== rest.length) return null;
  return second.value.startsWith('b/') ? second.value.slice(2) : null;
}

/**
 * Extracts the a-side (pre-patch) repository path from a `diff --git` header.
 * For rename/copy sections this is a different path than the b-side item, and
 * `git apply` still needs its pre-image present to run the section at all.
 */
export function parsePatchPreimagePath(section: Buffer): string | null {
  const lineEnd = section.indexOf('\n');
  const header = section.subarray(0, lineEnd === -1 ? section.byteLength : lineEnd).toString('utf8');
  if (!header.startsWith(DIFF_HEADER)) return null;
  const rest = header.slice(DIFF_HEADER.length);
  if (!rest.startsWith('"')) {
    const separator = rest.indexOf(' b/');
    if (separator === -1) return null;
    const raw = rest.slice(0, separator);
    return raw.startsWith('a/') && raw.length > 2 ? raw.slice(2) : null;
  }
  const first = readQuoted(rest, 0);
  if (first === null) return null;
  return first.value.startsWith('a/') && first.value.length > 2 ? first.value.slice(2) : null;
}

/**
 * Evidence-borne paths (patch section headers, untracked manifest entries) are
 * not constrained to the repository envelope by digest validation, and
 * apply-back skips the materializer's ls-files cross-check that would reject
 * `.git` entries — so every path is gated here before it can name a write
 * target.
 */
function safeRepositoryPath(relative: string): string | null {
  if (!relative || relative.includes('\\') || relative.includes('\0')) return null;
  if (relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) return null;
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')) {
    return null;
  }
  return relative;
}

function sectionLabel(section: Buffer): string {
  const lineEnd = section.indexOf('\n');
  const header = section.subarray(0, lineEnd === -1 ? section.byteLength : lineEnd).toString('utf8');
  const rest = header.slice(DIFF_HEADER.length);
  return rest.length > 80 ? `${rest.slice(0, 77)}...` : rest;
}

/** Groups the evidence's patch streams and untracked blobs into per-path work items. */
export function buildPortableEvidenceWorkItems(evidence: AnchorWorkspaceEvidence): {
  items: PortableEvidenceWorkItem[];
  invalid: PortableEvidenceInvalidSection[];
} {
  const streams: Array<{ patch: Buffer; source: PortableEvidenceFileSource }> = [
    { patch: Buffer.from(evidence.payload.stagedPatchBase64, 'base64'), source: 'staged-patch' },
    { patch: Buffer.from(evidence.payload.unstagedPatchBase64, 'base64'), source: 'unstaged-patch' },
  ];
  const items: PortableEvidenceWorkItem[] = [];
  const invalid: PortableEvidenceInvalidSection[] = [];
  const patchByPath = new Map<string, PortableEvidencePatchWorkItem>();
  for (const stream of streams) {
    for (const section of splitPatchSections(stream.patch)) {
      const headerPath = parsePatchPath(section);
      const safePath = headerPath === null ? null : safeRepositoryPath(headerPath);
      if (safePath === null) {
        invalid.push({
          label: sectionLabel(section),
          source: stream.source,
          reason: headerPath === null
            ? 'patch section header could not be parsed to a repository path'
            : 'patch section targets a path outside the repository safety envelope',
        });
        continue;
      }
      const existing = patchByPath.get(safePath);
      if (existing) existing.sections.push(section);
      else {
        const item: PortableEvidencePatchWorkItem = {
          kind: 'patch',
          path: safePath,
          source: stream.source,
          sections: [section],
        };
        patchByPath.set(safePath, item);
        items.push(item);
      }
    }
  }
  for (const file of evidence.manifest.untrackedFiles) {
    const safePath = safeRepositoryPath(file.path);
    if (safePath === null) {
      invalid.push({
        label: file.path,
        source: 'untracked',
        reason: 'untracked entry targets a path outside the repository safety envelope',
      });
      continue;
    }
    items.push({
      kind: 'untracked',
      path: safePath,
      source: 'untracked',
      bytes: Buffer.from(evidence.payload.untrackedBlobs[file.sha256], 'base64'),
      mode: file.mode,
    });
  }
  return { items, invalid };
}
