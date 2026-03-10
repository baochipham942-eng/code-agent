import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeForComparison(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function resolveSandboxPath(
  inputPath: string,
  workingDirectories: string[],
  baseDirectory = workingDirectories[0] ?? process.cwd()
): string {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(baseDirectory, inputPath);
  const resolved = path.resolve(candidate);
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
