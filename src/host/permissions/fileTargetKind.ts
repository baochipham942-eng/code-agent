import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FileTargetKind } from '../../shared/contract/permission';
import { resolveInputPath } from '../tools/utils/resolveInputPath';

export interface FileTargetKindOptions {
  /** How the tool's I/O reaches the target; decides what a write actually does to it. */
  writeMode?: 'atomic-replace' | 'write-through';
  /**
   * Write/Append expand `~` via resolveInputPath; Edit (multiEdit) treats `~` as a
   * literal directory name — and the permission classifier auto-allows literal
   * in-workspace `~/...` paths, so expanding here without changing the boundary
   * classifier would silently edit home-directory files without approval. Keep the
   * per-tool behavior and mirror it, never "align" one side alone.
   */
  expandTilde?: boolean;
}

/**
 * Classify a file-write target by what the write will actually do to it.
 *
 * Renderer used to infer this from the raw file_path string; four #1692
 * constructions each stripped the overwrite warning from a real file
 * (`/dev/shm/...` prefix, POSIX `NUL`, backslash folding, Windows
 * `/dev/null` → `C:\dev\null`). Only the final inode kind is reliable.
 *
 * Rules mirror the tool's real I/O:
 * - The path is resolved like the tool resolves it: optional tilde expansion
 *   (per tool, see FileTargetKindOptions.expandTilde) + cwd join, then the lexical
 *   `path.resolve` the Write/Append/Edit modules apply, so `..` segments collapse
 *   the same way and a symlinked directory component cannot redirect
 *   classification to a different target than the write.
 * - `atomic-replace` (Write/Edit, `atomicWriteFile`'s rename): `lstat` —
 *   the rename replaces a symlink itself instead of writing through it, so a
 *   symlink, even one pointing at `/dev/null`, is an overwrite. A bare
 *   character device is `device`, but the node itself is what gets replaced.
 * - `write-through` (Append's `fs.appendFile`, reads): `stat` — content goes
 *   through a symlink to its target, so a symlink to `/dev/null` IS a device
 *   write and the node survives.
 *
 * Anything else we can stat — regular files, directories, FIFOs, block
 * devices — is `regular`. Block devices stay regular on purpose: writing
 * `/dev/sda` does overwrite, so the device copy would be a lie.
 * Stat failure / empty input → `unknown` (renderer fail-closes to overwrite).
 */
export function resolveFileTargetKind(
  rawPath: unknown,
  cwd: string = process.cwd(),
  options: FileTargetKindOptions = {},
): FileTargetKind {
  if (typeof rawPath !== 'string') return 'unknown';
  if (!rawPath.trim()) return 'unknown';
  const { writeMode = 'atomic-replace', expandTilde = true } = options;
  try {
    const joined = expandTilde ? resolveInputPath(rawPath, cwd) : path.resolve(cwd, rawPath);
    const resolved = path.resolve(joined);
    if (writeMode === 'write-through') {
      return statSync(resolved).isCharacterDevice() ? 'device' : 'regular';
    }
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) return 'regular';
    if (stat.isCharacterDevice()) return 'device';
    return 'regular';
  } catch {
    return 'unknown';
  }
}
