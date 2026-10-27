// ============================================================================
// Non-zip archive listing via system tar (bsdtar lists tar/tar.gz/7z/rar).
// execFile argument array only — the path never goes through a shell.
// ============================================================================

import { execFile as execFileCb } from 'child_process';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';

type ArchiveListFormat = 'tar' | 'tgz' | 'gz' | '7z' | 'rar';

interface ArchiveListEntry {
  name: string;
  isDirectory: boolean;
  depth: number;
  extension?: string;
}

export interface ArchiveListDependencies {
  execFile?: (
    file: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

const TAR_TIMEOUT_MS = 20_000;
const TAR_MAX_BUFFER = 8 * 1024 * 1024;

export function classifyArchiveFailure(text: string): 'encrypted' | 'corrupt' | 'unsupported' | null {
  const lower = text.toLowerCase();
  if (/passphrase|password|encrypt/.test(lower)) return 'encrypted';
  if (/unsupported|unrecognized archive|mtree specification|not a tar/.test(lower)) return 'unsupported';
  if (/damaged|truncat|corrupt|checksum|unexpected eof/.test(lower)) return 'corrupt';
  return null;
}

export function archiveListFormat(filePath: string): ArchiveListFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.rar')) return 'rar';
  return null;
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args as string[], { ...options, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const failure = err as NodeJS.ErrnoException & { stderr?: string };
        failure.stderr = String(stderr ?? '');
        reject(failure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function failureText(err: unknown): string {
  const stderr = err && typeof err === 'object' && 'stderr' in err
    ? String((err as { stderr?: unknown }).stderr ?? '')
    : '';
  const message = err instanceof Error ? err.message : String(err);
  return `${stderr}\n${message}`;
}

/** POSIX ustar magic sits at offset 257. A plain gzip of one file does not. */
export function gzipPayloadLooksLikeTar(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const source = createReadStream(filePath);
    const gunzip = createGunzip();
    const stop = () => {
      source.destroy();
      gunzip.destroy();
    };
    source.pipe(gunzip);
    gunzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= 512) {
        stop();
        finish(hasUstar(Buffer.concat(chunks)));
      }
    });
    gunzip.on('end', () => finish(hasUstar(Buffer.concat(chunks))));
    gunzip.on('error', () => finish(false));
    source.on('error', () => finish(false));
  });
}

function hasUstar(buf: Buffer): boolean {
  if (buf.length < 262) return false;
  return buf.subarray(257, 262).toString('ascii') === 'ustar';
}

function entriesFromTarList(stdout: string): ArchiveListEntry[] {
  const seen = new Set<string>();
  const entries: ArchiveListEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const name = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!name || name === '.' || seen.has(name)) continue;
    seen.add(name);
    const isDirectory = name.endsWith('/');
    const segments = name.split('/').filter(Boolean);
    const leaf = segments[segments.length - 1] || name;
    const dot = leaf.lastIndexOf('.');
    entries.push({
      name,
      isDirectory,
      depth: Math.max(0, segments.length - 1),
      extension: !isDirectory && dot > 0 ? leaf.slice(dot + 1).toLowerCase() : undefined,
    });
  }
  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return entries;
}

export async function listTarArchive(
  filePath: string,
  dependencies: ArchiveListDependencies = {},
): Promise<{ entries: ArchiveListEntry[] } | { code: 'encrypted' | 'corrupt' | 'unsupported' }> {
  const exec = dependencies.execFile ?? defaultExecFile;
  try {
    const { stdout } = await exec('tar', ['-tf', filePath], {
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: TAR_MAX_BUFFER,
    });
    return { entries: entriesFromTarList(stdout) };
  } catch (err) {
    const code = classifyArchiveFailure(failureText(err));
    if (!code) throw err;
    return { code };
  }
}
