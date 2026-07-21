import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

function regularFiles(root: string, current: string, output: string[]): void {
  const currentStat = lstatSync(current);
  if (currentStat.isSymbolicLink()) {
    throw new Error(`Refusing to scan symbolic link under acceptance root: ${current}`);
  }
  if (currentStat.isFile()) {
    output.push(current);
    return;
  }
  if (!currentStat.isDirectory()) return;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to scan symbolic link under acceptance root: ${path}`);
    }
    regularFiles(root, path, output);
  }
}

export function listAcceptanceRegularFiles(root: string): string[] {
  const resolvedRoot = resolve(root);
  const files: string[] = [];
  regularFiles(resolvedRoot, resolvedRoot, files);
  return files.sort((left, right) => left.localeCompare(right));
}

export function assertAcceptanceCanaryAbsent(
  canary: string,
  roots: readonly string[],
): string[] {
  const marker = Buffer.from(canary, 'utf8');
  const files = Array.from(new Set(roots.flatMap(listAcceptanceRegularFiles)))
    .sort((left, right) => left.localeCompare(right));
  for (const path of files) {
    if (readFileSync(path).includes(marker)) {
      throw new Error(`Redaction canary leaked to ${path}`);
    }
  }
  return files;
}
