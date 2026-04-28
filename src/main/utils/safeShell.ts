// ============================================================================
// Safe Shell - 替代 exec(模板字符串) 避免命令注入
// ============================================================================
//
// 用法约束：
// - cmd 必须是受信任的常量（'open', 'xdg-open', 'osascript', 'explorer.exe' 等）
// - args 数组里的元素直接传给进程，不走 shell，含特殊字符也安全
// - 打开 URL 必须先 assertSafeUrl()，打开路径必须先 assertExistingAbsolutePath()
// ============================================================================

import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

export interface SafeExecOptions {
  timeoutMs?: number;
  encoding?: BufferEncoding;
  cwd?: string;
}

export interface SafeExecResult {
  stdout: string;
  stderr: string;
}

export async function safeExec(
  cmd: string,
  args: string[] = [],
  opts: SafeExecOptions = {},
): Promise<SafeExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: opts.encoding ?? 'utf-8',
    cwd: opts.cwd,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export function safeExecWithStdin(
  cmd: string,
  args: string[],
  input: string | Buffer,
  opts: SafeExecOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: opts.cwd,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${cmd} (exit ${code}): ${stderr.slice(0, 200)}`));
      } else {
        resolve();
      }
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

export function safeExecSyncWithStdin(
  cmd: string,
  args: string[],
  input: string | Buffer,
  opts: SafeExecOptions = {},
): void {
  const result = spawnSync(cmd, args, {
    input,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cwd: opts.cwd,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} (exit ${result.status})`);
  }
}

export function safeExecDetached(
  cmd: string,
  args: string[] = [],
  onError?: (err: Error) => void,
): void {
  execFile(cmd, args, (err) => {
    if (err && onError) onError(err);
  });
}

const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function assertSafeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input.slice(0, 80)}`);
  }
  if (!SAFE_URL_SCHEMES.has(url.protocol)) {
    throw new Error(`Unsafe URL scheme: ${url.protocol}`);
  }
  return url;
}

export function assertExistingAbsolutePath(input: string): string {
  if (!path.isAbsolute(input)) {
    throw new Error(`Path must be absolute: ${input}`);
  }
  if (!fs.existsSync(input)) {
    throw new Error(`Path does not exist: ${input}`);
  }
  return input;
}
