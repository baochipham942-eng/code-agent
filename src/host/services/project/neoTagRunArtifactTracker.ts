import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import type { NeoWriteScope } from '../../../shared/contract/tag';

type AllowRule =
  | { kind: 'exact'; relPath: string; directory: boolean }
  | { kind: 'glob'; pattern: string };

type FileFingerprint = { exists: true; hash: string } | { exists: false };

export interface NeoTagRunArtifactSnapshot {
  workingDirectory: string;
  writeScope: NeoWriteScope;
  rules: AllowRule[];
  files: Map<string, FileFingerprint>;
}

const DEFAULT_IGNORES = ['.git/**', 'node_modules/**'];

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function cleanRelativePath(rawPath: string, workingDirectory: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(path.resolve(workingDirectory), path.resolve(trimmed));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return toPosixPath(relative);
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function hasGlobSyntax(filePath: string): boolean {
  return /[*?[\]{}()!+@]/.test(filePath);
}

async function buildAllowRules(workingDirectory: string, writeScope: NeoWriteScope): Promise<AllowRule[]> {
  if (writeScope.mode !== 'current_project') return [];
  const rules: AllowRule[] = [];
  for (const allowedPath of writeScope.allowedPaths) {
    const relPath = cleanRelativePath(allowedPath, workingDirectory);
    if (!relPath) continue;
    if (hasGlobSyntax(relPath)) {
      rules.push({ kind: 'glob', pattern: relPath });
      continue;
    }
    const absolute = path.join(workingDirectory, relPath);
    let directory = allowedPath.endsWith('/') || allowedPath.endsWith(path.sep);
    try {
      directory = (await stat(absolute)).isDirectory();
    } catch {
      // Missing exact paths are still tracked so a permitted create is visible.
    }
    rules.push({ kind: 'exact', relPath, directory });
  }
  return rules;
}

async function listDirectoryFiles(root: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryName = String(entry.name);
    const child = relativeDir ? `${relativeDir}/${entryName}` : entryName;
    if (child === '.git' || child === 'node_modules' || child.startsWith('.git/') || child.startsWith('node_modules/')) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await listDirectoryFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function collectAllowedFiles(workingDirectory: string, rules: AllowRule[]): Promise<Set<string>> {
  const files = new Set<string>();
  for (const rule of rules) {
    if (rule.kind === 'glob') {
      const matches = await glob(rule.pattern, {
        cwd: workingDirectory,
        nodir: true,
        dot: true,
        ignore: DEFAULT_IGNORES,
        posix: true,
      });
      for (const match of matches) files.add(match);
      continue;
    }
    if (rule.directory) {
      for (const filePath of await listDirectoryFiles(workingDirectory, rule.relPath)) {
        files.add(filePath);
      }
    } else {
      files.add(rule.relPath);
    }
  }
  return files;
}

async function fingerprintFile(workingDirectory: string, relPath: string): Promise<FileFingerprint> {
  const absolute = path.join(workingDirectory, relPath);
  try {
    const fileStat = await stat(absolute);
    if (!fileStat.isFile()) return { exists: false };
    const content = await readFile(absolute);
    return { exists: true, hash: createHash('sha256').update(content).digest('hex') };
  } catch {
    return { exists: false };
  }
}

async function snapshotFiles(
  workingDirectory: string,
  writeScope: NeoWriteScope,
  rules: AllowRule[],
): Promise<Map<string, FileFingerprint>> {
  if (!writeScope.canCreateFiles && !writeScope.canModifyFiles) return new Map();
  const files = await collectAllowedFiles(workingDirectory, rules);
  const snapshot = new Map<string, FileFingerprint>();
  for (const filePath of files) {
    snapshot.set(filePath, await fingerprintFile(workingDirectory, filePath));
  }
  return snapshot;
}

function isAllowedByRules(relPath: string, rules: AllowRule[]): boolean {
  return rules.some((rule) => {
    if (rule.kind === 'glob') return minimatch(relPath, rule.pattern, { dot: true });
    if (rule.directory) return relPath === rule.relPath || relPath.startsWith(`${rule.relPath}/`);
    return relPath === rule.relPath;
  });
}

function changedWithinApprovedOperation(
  before: FileFingerprint | undefined,
  after: FileFingerprint | undefined,
  writeScope: NeoWriteScope,
): boolean {
  const beforeExists = before?.exists === true;
  const afterExists = after?.exists === true;
  if (!beforeExists && afterExists) return writeScope.canCreateFiles;
  if (beforeExists && !afterExists) return writeScope.canModifyFiles;
  if (beforeExists && afterExists && before.hash !== after.hash) return writeScope.canModifyFiles;
  return false;
}

export async function createNeoTagRunArtifactSnapshot(
  workingDirectory: string | undefined,
  writeScope: NeoWriteScope,
): Promise<NeoTagRunArtifactSnapshot | null> {
  if (!workingDirectory) return null;
  const root = path.resolve(workingDirectory);
  const rules = await buildAllowRules(root, writeScope);
  return {
    workingDirectory: root,
    writeScope,
    rules,
    files: await snapshotFiles(root, writeScope, rules),
  };
}

export async function collectNeoTagChangedFiles(
  before: NeoTagRunArtifactSnapshot | null,
): Promise<string[]> {
  if (!before || before.rules.length === 0) return [];
  const afterFiles = await snapshotFiles(before.workingDirectory, before.writeScope, before.rules);
  const candidates = new Set([...before.files.keys(), ...afterFiles.keys()]);
  const changed: string[] = [];
  for (const filePath of candidates) {
    if (!isAllowedByRules(filePath, before.rules)) continue;
    if (changedWithinApprovedOperation(before.files.get(filePath), afterFiles.get(filePath), before.writeScope)) {
      changed.push(filePath);
    }
  }
  return changed.sort((a, b) => a.localeCompare(b));
}
