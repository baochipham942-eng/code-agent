import fs from 'fs';
import { installLogPath } from './layout';

const STDERR_TAIL_LINES = 40;

export function appendInstallLog(root: string, at: Date, line: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(installLogPath(root), `[${at.toISOString()}] ${line}\n`);
}

function stderrTail(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-STDERR_TAIL_LINES);
}

export function appendUvOutcome(root: string, at: Date, result: { code: number; stderr: string }): void {
  appendInstallLog(root, at, `uv exit: ${result.code}`);
  for (const line of stderrTail(result.stderr)) {
    appendInstallLog(root, at, `uv stderr: ${line}`);
  }
}
