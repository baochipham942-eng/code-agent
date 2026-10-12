import type { AnchorWorkspaceEvidence } from './types';

type PortableEvidenceFileSource = 'staged-patch' | 'unstaged-patch' | 'untracked';

interface PortableEvidencePatchWorkItem {
  kind: 'patch';
  path: string;
  source: PortableEvidenceFileSource;
  sections: Buffer[];
  /** Safe a-side paths of rename/copy sections: also touched by an apply. */
  preimagePaths: string[];
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

interface PatchSectionMeta {
  /** Pre-image repository path; null when absent or `/dev/null` (new file). */
  aPath: string | null;
  /** Post-patch repository path; null when no source yields one. */
  bPath: string | null;
  /** True for `deleted file mode` sections and `+++ /dev/null` deletions. */
  isDeletion: boolean;
}

function sidePath(name: string, prefix: 'a/' | 'b/'): string | null {
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null;
}

/** Decodes a metadata-line name: quoted (quotepath escapes) or the raw rest of the line. */
function unquoteMetadataName(raw: string): string | null {
  if (!raw.startsWith('"')) return raw.length > 0 ? raw : null;
  const decoded = readQuoted(raw, 0);
  return decoded !== null && decoded.end === raw.length ? decoded.value : null;
}

/**
 * The `diff --git` header alone cannot name paths reliably: git leaves paths
 * containing spaces unquoted, so `diff --git a/docs b/x b/docs b/x` splits
 * wrongly at the first ` b/`. The `--- a/…` / `+++ b/…` lines and the
 * `rename from` / `rename to` lines carry whole-line paths and are
 * unambiguous, so they win; the header is only the fallback, where a split
 * whose two sides name the same path is preferred over the first ` b/`.
 */
function headerPaths(rest: string): { a: string | null; b: string | null } {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (first === null || rest[first.end] !== ' ') return { a: null, b: null };
    const second = readQuoted(rest, first.end + 1);
    if (second?.end !== rest.length) return { a: null, b: null };
    return { a: sidePath(first.value, 'a/'), b: sidePath(second.value, 'b/') };
  }
  let consistent = -1;
  let scan = 0;
  for (;;) {
    const found = rest.indexOf(' b/', scan);
    if (found === -1) break;
    const left = rest.slice(0, found);
    const right = rest.slice(found + 3);
    if (left.startsWith('a/') && left.length > 2 && !right.startsWith('"') && left.slice(2) === right) {
      consistent = found;
    }
    scan = found + 1;
  }
  const separator = consistent !== -1 ? consistent : rest.indexOf(' b/');
  if (separator === -1) return { a: null, b: null };
  // The ` b/` separator already carries the b-side prefix, so the right side
  // is the bare path (unlike the quoted branch, where names keep their prefix).
  const right = rest.slice(separator + 3);
  return {
    a: sidePath(rest.slice(0, separator), 'a/'),
    b: right.startsWith('"') || right.length === 0 ? null : right,
  };
}

/**
 * Extracts both repository paths of one patch section. Metadata lines are only
 * scanned up to the first hunk (`@@`) or binary payload (`GIT binary patch`);
 * content lines that merely look like headers never reach the parser.
 */
function parsePatchSectionMeta(section: Buffer): PatchSectionMeta | null {
  const newline = section.indexOf('\n');
  const header = section.subarray(0, newline === -1 ? section.byteLength : newline).toString('utf8');
  if (!header.startsWith(DIFF_HEADER)) return null;
  let minusName: string | null = null;
  let plusName: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let sawMinus = false;
  let sawPlus = false;
  let plusDevNull = false;
  let deletedMode = false;
  // git delimits an unquoted `---`/`+++` path from any trailing timestamp with
  // a TAB, so exactly one trailing TAB belongs to the line, never the path.
  const stripTrailingTab = (raw: string): string => (raw.endsWith('\t') ? raw.slice(0, -1) : raw);
  for (let offset = newline + 1; offset < section.byteLength;) {
    const next = section.indexOf('\n', offset);
    const line = section.subarray(offset, next === -1 ? section.byteLength : next).toString('utf8');
    offset = next === -1 ? section.byteLength : next + 1;
    if (line.startsWith('@@') || line === 'GIT binary patch') break;
    if (!sawMinus && line.startsWith('--- ')) {
      sawMinus = true;
      minusName = unquoteMetadataName(stripTrailingTab(line.slice(4)));
    } else if (!sawPlus && line.startsWith('+++ ')) {
      sawPlus = true;
      const name = unquoteMetadataName(stripTrailingTab(line.slice(4)));
      if (name === '/dev/null') plusDevNull = true;
      else plusName = name;
    } else if (renameFrom === null && line.startsWith('rename from ')) {
      renameFrom = unquoteMetadataName(line.slice('rename from '.length));
    } else if (renameTo === null && line.startsWith('rename to ')) {
      renameTo = unquoteMetadataName(line.slice('rename to '.length));
    } else if (renameFrom === null && line.startsWith('copy from ')) {
      renameFrom = unquoteMetadataName(line.slice('copy from '.length));
    } else if (renameTo === null && line.startsWith('copy to ')) {
      renameTo = unquoteMetadataName(line.slice('copy to '.length));
    } else if (line.startsWith('deleted file mode ')) {
      deletedMode = true;
    }
  }
  const fallback = headerPaths(header.slice(DIFF_HEADER.length));
  let aPath: string | null;
  if (sawMinus) aPath = minusName === null ? null : sidePath(minusName, 'a/');
  else if (renameFrom !== null) aPath = renameFrom;
  else aPath = fallback.a;
  // A `+++ /dev/null` deletion keeps falling through: the deleted path equals
  // the a-side name, which the header fallback recovers (`a/f b/f`).
  let bPath: string | null;
  if (sawPlus && !plusDevNull) bPath = plusName === null ? null : sidePath(plusName, 'b/');
  else if (renameTo !== null) bPath = renameTo;
  else bPath = fallback.b;
  return { aPath, bPath, isDeletion: deletedMode || plusDevNull };
}

/**
 * Extracts the a-side (pre-patch) repository path from a patch section. For
 * rename/copy sections this is a different path than the b-side item, and
 * `git apply` still needs its pre-image present to run the section at all.
 */
export function parsePatchPreimagePath(section: Buffer): string | null {
  return parsePatchSectionMeta(section)?.aPath ?? null;
}

/**
 * Evidence-borne paths (patch section headers, untracked manifest entries) are
 * not constrained to the repository envelope by digest validation, and
 * apply-back skips the materializer's ls-files cross-check that would reject
 * `.git` entries — so every path is gated here before it can name a write
 * target. Exported because the apply-back engine runs the SAME gate on the
 * paths it derives itself (rename pre-images, sidecar slots).
 */
export function safeRepositoryPath(relative: string): string | null {
  if (!relative || relative.includes('\\') || relative.includes('\0')) return null;
  if (relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) return null;
  const segments = relative.split('/');
  // `.git` compares case-insensitively: on macOS/Windows volumes a `.GIT`
  // entry resolves into the real `.git` directory and would write git
  // metadata; case-sensitive volumes only lose a pathological legit name.
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
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

/**
 * Groups the evidence's patch streams and untracked blobs into per-path work
 * items. `unsafe` collects every path (a-side or b-side of a section, untracked
 * entry) that fails the safety-envelope gate: such evidence is rejected as a
 * whole, while `invalid` keeps merely unparseable sections as per-file reports.
 */
export function buildPortableEvidenceWorkItems(evidence: AnchorWorkspaceEvidence): {
  items: PortableEvidenceWorkItem[];
  invalid: PortableEvidenceInvalidSection[];
  unsafe: PortableEvidenceInvalidSection[];
} {
  const streams: Array<{ patch: Buffer; source: PortableEvidenceFileSource }> = [
    { patch: Buffer.from(evidence.payload.stagedPatchBase64, 'base64'), source: 'staged-patch' },
    { patch: Buffer.from(evidence.payload.unstagedPatchBase64, 'base64'), source: 'unstaged-patch' },
  ];
  const items: PortableEvidenceWorkItem[] = [];
  const invalid: PortableEvidenceInvalidSection[] = [];
  const unsafe: PortableEvidenceInvalidSection[] = [];
  const patchByPath = new Map<string, PortableEvidencePatchWorkItem>();
  const patchDeletionOnly = new Map<string, boolean>();
  for (const stream of streams) {
    for (const section of splitPatchSections(stream.patch)) {
      const meta = parsePatchSectionMeta(section);
      if (meta?.bPath == null) {
        invalid.push({
          label: sectionLabel(section),
          source: stream.source,
          reason: 'patch section header could not be parsed to a repository path',
        });
        continue;
      }
      const safePath = safeRepositoryPath(meta.bPath);
      if (safePath === null) {
        unsafe.push({
          label: sectionLabel(section),
          source: stream.source,
          reason: 'patch section targets a path outside the repository safety envelope',
        });
        continue;
      }
      const safePreimage = meta.aPath === null ? null : safeRepositoryPath(meta.aPath);
      if (meta.aPath !== null && safePreimage === null) {
        unsafe.push({
          label: sectionLabel(section),
          source: stream.source,
          reason: 'patch section pre-image (a-side) path is outside the repository safety envelope',
        });
        continue;
      }
      const existing = patchByPath.get(safePath);
      if (existing) {
        existing.sections.push(section);
        patchDeletionOnly.set(safePath, (patchDeletionOnly.get(safePath) ?? true) && meta.isDeletion);
        if (safePreimage !== null && safePreimage !== safePath && !existing.preimagePaths.includes(safePreimage)) {
          existing.preimagePaths.push(safePreimage);
        }
      } else {
        const item: PortableEvidencePatchWorkItem = {
          kind: 'patch',
          path: safePath,
          source: stream.source,
          sections: [section],
          preimagePaths: safePreimage !== null && safePreimage !== safePath ? [safePreimage] : [],
        };
        patchByPath.set(safePath, item);
        patchDeletionOnly.set(safePath, meta.isDeletion);
        items.push(item);
      }
    }
  }
  for (const file of evidence.manifest.untrackedFiles) {
    const safePath = safeRepositoryPath(file.path);
    if (safePath === null) {
      unsafe.push({
        label: file.path,
        source: 'untracked',
        reason: 'untracked entry targets a path outside the repository safety envelope',
      });
      continue;
    }
    const overlap = patchByPath.get(safePath);
    if (overlap) {
      if (patchDeletionOnly.get(safePath) === true) {
        // The one shape real capture produces for this overlap: `git rm --cached`
        // keeps the disk copy, so the manifest lists the path as untracked while
        // the staged patch deletes it from the index. Apply-back is worktree-only
        // and the untracked blob IS the cloud disk state, so the patch item is
        // dropped instead of deleting the file just to recreate it.
        items.splice(items.indexOf(overlap), 1);
        patchByPath.delete(safePath);
      } else {
        unsafe.push({
          label: safePath,
          source: 'untracked',
          reason: 'untracked entry duplicates a tracked path the patch modifies; evidence is inconsistent',
        });
        continue;
      }
    }
    items.push({
      kind: 'untracked',
      path: safePath,
      source: 'untracked',
      bytes: Buffer.from(evidence.payload.untrackedBlobs[file.sha256], 'base64'),
      mode: file.mode,
    });
  }
  return { items, invalid, unsafe };
}
