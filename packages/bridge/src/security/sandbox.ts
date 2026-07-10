import fs from 'node:fs/promises';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

function normalizeForComparison(inputPath: string): string {
  const resolved = resolveCanonicalSandboxPath(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Resolve existing symlink ancestors while retaining a not-yet-created suffix. */
export function resolveCanonicalSandboxPath(inputPath: string, symlinkDepth = 0): string {
  const resolved = path.resolve(inputPath);
  if (symlinkDepth > 40) {
    throw new Error(`Too many symbolic links while resolving sandbox path: ${resolved}`);
  }

  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(cursor, parts[index]);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(next), readlinkSync(next));
        return resolveCanonicalSandboxPath(
          path.resolve(target, ...parts.slice(index + 1)),
          symlinkDepth + 1,
        );
      }
      cursor = next;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        return path.resolve(realpathSync.native(cursor), ...parts.slice(index));
      } catch (realpathError) {
        if (!isMissingPathError(realpathError)) throw realpathError;
        return path.resolve(cursor, ...parts.slice(index));
      }
    }
  }

  return realpathSync.native(cursor);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function resolveSandboxPath(
  inputPath: string,
  workingDirectories: string[],
  baseDirectory = workingDirectories[0] ?? process.cwd()
): string {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(baseDirectory, inputPath);
  const resolved = resolveCanonicalSandboxPath(candidate);
  const normalizedResolved = normalizeForComparison(resolved);
  const allowed = workingDirectories.some((dir) => {
    const normalized = normalizeForComparison(dir);
    return normalizedResolved === normalized || normalizedResolved.startsWith(`${normalized}${path.sep}`);
  });

  if (!allowed) {
    throw new Error(`Path is outside sandbox: ${resolved}`);
  }

  return resolved;
}

export async function ensureSandboxDir(
  inputPath: string,
  workingDirectories: string[],
  baseDirectory?: string
): Promise<string> {
  const resolved = resolveSandboxPath(inputPath, workingDirectories, baseDirectory);
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}
