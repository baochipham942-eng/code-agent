import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePatchPreimagePath } from './portableEvidenceWorkItems';
import type { PortableEvidenceWorkItem } from './portableEvidenceWorkItems';
import type { WorkspaceCommandRunner } from './types';

export const CONFLICT_OPTIONS = ['keep-local', 'take-cloud', 'save-as'] as const;
export type PortableEvidenceConflictOption = (typeof CONFLICT_OPTIONS)[number];

const MAX_SIDECAR_ATTEMPTS = 64;

type PortableEvidenceFileStatus =
  | 'would-apply' | 'already-present' | 'conflict'
  | 'applied' | 'kept-local' | 'took-cloud' | 'saved-as-cloud';

export interface PortableEvidenceApplyBackFileReport {
  path: string;
  source: 'staged-patch' | 'unstaged-patch' | 'untracked';
  status: PortableEvidenceFileStatus;
  reason?: string;
  options?: readonly PortableEvidenceConflictOption[];
  savedAs?: string;
}

export interface PortableEvidenceClassification {
  status: 'would-apply' | 'already-present' | 'conflict';
  reason?: string;
}

type JournalEntry =
  | { kind: 'patch'; section: Buffer }
  | { kind: 'created-file'; target: string; createdDirs: string[] }
  | { kind: 'restore-file'; target: string; priorBytes: Buffer | null; createdDirs: string[] };

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ignoreMissingFile(error: unknown): void {
  if ((error as { code?: string }).code !== 'ENOENT') throw error;
}

function commandErrorReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') {
    for (const rawLine of stderr.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('error:')) return line.replace(/^error:\s*/u, '') || line;
    }
    const firstLine = stderr.split('\n').map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readFileIfExists(target: string): Promise<Buffer | null> {
  const info = await lstat(target).catch(() => null);
  return info?.isFile() ? await readFile(target) : null;
}

async function removeEmptyDirectories(directories: string[]): Promise<void> {
  for (const directory of [...directories].reverse()) {
    await rmdir(directory).catch(() => undefined);
  }
}

/**
 * Executes one apply-back against a single working tree. Every write is journaled
 * so an unexpected error can be rolled back to a byte-identical pre-call state.
 */
export class PortableEvidenceApplyBackEngine {
  private readonly journal: JournalEntry[] = [];

  constructor(
    private readonly runner: WorkspaceCommandRunner,
    private readonly root: string,
    private readonly baseCommit: string,
  ) {}

  private resolve(relative: string): string {
    return path.resolve(this.root, ...relative.split('/'));
  }

  private async git(args: string[], input?: Buffer): Promise<Buffer> {
    return (await this.runner.run({ executable: 'git', args, cwd: this.root, input })).stdout;
  }

  async treeStatusSnapshot(): Promise<string> {
    return (await this.git([
      '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ])).toString('utf8');
  }

  async checkPatchItem(item: PortableEvidenceWorkItem & { kind: 'patch' }): Promise<PortableEvidenceClassification> {
    try {
      await this.git(['apply', '--check', '--binary', '--whitespace=nowarn', '-'], Buffer.concat(item.sections));
      return { status: 'would-apply' };
    } catch (error) {
      return { status: 'conflict', reason: commandErrorReason(error) };
    }
  }

  async checkUntrackedItem(
    item: PortableEvidenceWorkItem & { kind: 'untracked' },
  ): Promise<PortableEvidenceClassification> {
    const target = this.resolve(item.path);
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) {
      return { status: 'conflict', reason: 'local path exists and is not a regular file' };
    }
    if (info) {
      return sha256Hex(await readFile(target)) === sha256Hex(item.bytes)
        ? { status: 'already-present' }
        : { status: 'conflict', reason: 'local file exists with different content than the cloud copy' };
    }
    const blocked = await this.findBlockedAncestor(item.path);
    return blocked
      ? { status: 'conflict', reason: `ancestor ${blocked} exists and is not a directory` }
      : { status: 'would-apply' };
  }

  private async findBlockedAncestor(relative: string): Promise<string | null> {
    let current = this.root;
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (info) {
        if (!info.isDirectory()) return path.relative(this.root, current) || segment;
        continue;
      }
      return null;
    }
    return null;
  }

  private async createDirectories(directory: string): Promise<string[]> {
    const created: string[] = [];
    const relative = path.relative(this.root, directory);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return created;
    let current = this.root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (info?.isDirectory()) continue;
      if (info) throw new Error(`cannot create directory ${current}: path exists and is not a directory`);
      await mkdir(current);
      created.push(current);
    }
    return created;
  }

  async applyPatchSection(section: Buffer): Promise<void> {
    await this.git(['apply', '--binary', '--whitespace=nowarn', '-'], section);
    this.journal.push({ kind: 'patch', section });
  }

  async applyUntrackedItem(item: PortableEvidenceWorkItem & { kind: 'untracked' }): Promise<void> {
    const target = this.resolve(item.path);
    const createdDirs = await this.createDirectories(path.dirname(target));
    await writeFile(target, item.bytes);
    await chmod(target, item.mode);
    this.journal.push({ kind: 'created-file', target, createdDirs });
  }

  private async restoreBaseContent(relative: string, target: string): Promise<void> {
    const spec = `${this.baseCommit}:${relative}`;
    const existsInBase = await this.runner
      .run({ executable: 'git', args: ['cat-file', '-e', spec], cwd: this.root })
      .then(() => true, () => false);
    if (existsInBase) {
      await writeFile(target, await this.git(['cat-file', 'blob', spec]));
      return;
    }
    if (await readFileIfExists(target)) await unlink(target);
  }

  /**
   * Snapshots the local bytes for rollback, then rebuilds the cloud-side final
   * state at the local path: pristine base-commit content plus the evidence's
   * own patch sections, which always apply against that exact pre-image.
   */
  private async beginCloudOverwrite(item: PortableEvidenceWorkItem): Promise<{ target: string }> {
    const target = this.resolve(item.path);
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) throw new Error(`refusing to overwrite non-regular local path: ${item.path}`);
    const priorBytes = await readFileIfExists(target);
    const createdDirs = await this.createDirectories(path.dirname(target));
    this.journal.push({ kind: 'restore-file', target, priorBytes, createdDirs });
    if (item.kind === 'untracked') {
      await writeFile(target, item.bytes);
      await chmod(target, item.mode);
    } else {
      await this.restoreBaseContent(item.path, target);
      for (const section of item.sections) {
        await this.restoreSectionPreimage(section, item.path);
        await this.applyPatchSection(section);
      }
    }
    return { target };
  }

  /**
   * A rename/copy section's pre-image lives at its a-side path, which may have
   * drifted locally even though the user adjudicated the b-side conflict.
   * Restoring that pre-image (journaled like any overwrite) is what lets
   * `git apply` run the section and honour the explicit take-cloud/save-as
   * resolution instead of failing the whole apply-back over a missing old path.
   */
  private async restoreSectionPreimage(section: Buffer, itemPath: string): Promise<void> {
    const preimagePath = parsePatchPreimagePath(section);
    if (preimagePath === null || preimagePath === itemPath) return;
    const target = this.resolve(preimagePath);
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) {
      throw new Error(`refusing to overwrite non-regular local path: ${preimagePath}`);
    }
    const priorBytes = await readFileIfExists(target);
    const createdDirs = await this.createDirectories(path.dirname(target));
    this.journal.push({ kind: 'restore-file', target, priorBytes, createdDirs });
    await this.restoreBaseContent(preimagePath, target);
  }

  async saveAsCloud(
    item: PortableEvidenceWorkItem,
  ): Promise<Omit<PortableEvidenceApplyBackFileReport, 'path' | 'source'>> {
    if (item.kind === 'untracked') {
      const savedAs = await this.writeCloudSidecar(item.path, item.bytes, item.mode);
      return { status: 'saved-as-cloud', savedAs };
    }
    // The cloud bytes only exist mid-rebuild, so undo the temporary overwrite
    // through the journal itself (mark back): leaving the restore-file/patch
    // entries behind would make a later rollback reverse-apply patches whose
    // effect was already hand-restored, aborting the whole rollback.
    const mark = this.journal.length;
    const { target } = await this.beginCloudOverwrite(item);
    const cloudBytes = await readFileIfExists(target);
    await this.rollbackTo(mark);
    if (cloudBytes === null) {
      return {
        status: 'kept-local',
        reason: 'the cloud copy deletes this file, so save-as has no cloud bytes to preserve',
      };
    }
    const savedAs = await this.writeCloudSidecar(item.path, cloudBytes);
    return { status: 'saved-as-cloud', savedAs };
  }

  /**
   * Saves the cloud bytes beside the local file without ever destroying prior
   * bytes: a byte-identical sidecar is reused as-is, while an occupied or
   * non-regular `<path>.cloud` shifts the write to `<path>.cloud.2`, `.cloud.3`,
   * ... so whatever was there survives both the success path and any rollback.
   * The sidecar is journaled as a restore-file, so a rollback removes exactly
   * the file this call created instead of unlinking a path it did not own.
   */
  private async writeCloudSidecar(itemPath: string, bytes: Buffer, mode?: number): Promise<string> {
    for (let attempt = 1; attempt <= MAX_SIDECAR_ATTEMPTS; attempt += 1) {
      const relative = attempt === 1 ? `${itemPath}.cloud` : `${itemPath}.cloud.${attempt}`;
      const target = this.resolve(relative);
      const info = await lstat(target).catch(() => null);
      if (info && !info.isFile()) continue;
      const prior = info ? await readFile(target) : null;
      if (prior !== null && !prior.equals(bytes)) continue;
      if (prior === null) {
        const createdDirs = await this.createDirectories(path.dirname(target));
        this.journal.push({ kind: 'restore-file', target, priorBytes: null, createdDirs });
        await writeFile(target, bytes);
        if (mode !== undefined) await chmod(target, mode);
      }
      return relative;
    }
    throw new Error(`no free ${itemPath}.cloud sidecar slot within ${MAX_SIDECAR_ATTEMPTS} attempts`);
  }

  async resolveConflict(
    item: PortableEvidenceWorkItem,
    classification: PortableEvidenceClassification,
    resolution: PortableEvidenceConflictOption | undefined,
  ): Promise<PortableEvidenceApplyBackFileReport> {
    if (resolution === undefined) {
      return {
        path: item.path,
        source: item.source,
        status: 'conflict',
        ...(classification.reason ? { reason: classification.reason } : {}),
        options: CONFLICT_OPTIONS,
      };
    }
    if (resolution === 'keep-local') {
      return { path: item.path, source: item.source, status: 'kept-local' };
    }
    if (resolution === 'take-cloud') {
      await this.beginCloudOverwrite(item);
      return { path: item.path, source: item.source, status: 'took-cloud' };
    }
    const saved = await this.saveAsCloud(item);
    return { path: item.path, source: item.source, ...saved };
  }

  private async rollbackEntries(entries: readonly JournalEntry[]): Promise<void> {
    for (const entry of [...entries].reverse()) {
      if (entry.kind === 'patch') {
        await this.git(['apply', '--reverse', '--binary', '--whitespace=nowarn', '-'], entry.section);
      } else if (entry.kind === 'created-file') {
        await unlink(entry.target).catch(ignoreMissingFile);
        await removeEmptyDirectories(entry.createdDirs);
      } else if (entry.priorBytes === null) {
        await unlink(entry.target).catch(ignoreMissingFile);
        await removeEmptyDirectories(entry.createdDirs);
      } else {
        await writeFile(entry.target, entry.priorBytes);
      }
    }
  }

  /** Undoes exactly the entries journalled after `mark`, leaving the rest intact. */
  private async rollbackTo(mark: number): Promise<void> {
    await this.rollbackEntries(this.journal.slice(mark));
    this.journal.length = mark;
  }

  async rollback(): Promise<void> {
    await this.rollbackEntries(this.journal);
    this.journal.length = 0;
  }
}
