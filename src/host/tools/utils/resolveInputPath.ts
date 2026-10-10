import * as os from 'os';
import * as path from 'path';

/** Expand a leading home-directory marker without changing other paths. */
export function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

export interface ParsedInput {
  inputPath: string;
  offset: number;
  limit: number;
}

/**
 * 兼容 AI 把参数写到 file_path 里的几种格式：
 *  1. "file.txt offset=10 limit=20"（带等号）
 *  2. "file.txt offset 10 limit 20"（空格分隔）
 *  3. "file.txt lines 7-9" / "file.txt lines 7"（行范围）
 * Read 工具与段调度共用这一份：调度侧算出的路径必须和工具真正打开的路径一致，
 * 否则同一文件的两种写法会被判为不冲突而并进同一段。
 */
export function parseEmbeddedParams(rawPath: string, rawOffset: number, rawLimit: number): ParsedInput {
  let inputPath = rawPath;
  let offset = rawOffset;
  let limit = rawLimit;

  if (inputPath.includes(' offset=') || inputPath.includes(' limit=')) {
    const parts = inputPath.split(' ');
    inputPath = parts[0];
    for (const part of parts.slice(1)) {
      const [key, value] = part.split('=');
      if (key === 'offset' && value && !isNaN(Number(value))) offset = Number(value);
      else if (key === 'limit' && value && !isNaN(Number(value))) limit = Number(value);
    }
  }

  const spaceMatch = inputPath.match(
    /^(.+?)\s+(offset|limit)\s+(\d+)(?:\s+(offset|limit)\s+(\d+))?$/i,
  );
  if (spaceMatch) {
    inputPath = spaceMatch[1].trim();
    const extracted: Record<string, number> = {};
    if (spaceMatch[2] && spaceMatch[3]) {
      extracted[spaceMatch[2].toLowerCase()] = parseInt(spaceMatch[3], 10);
    }
    if (spaceMatch[4] && spaceMatch[5]) {
      extracted[spaceMatch[4].toLowerCase()] = parseInt(spaceMatch[5], 10);
    }
    if (extracted.offset) offset = extracted.offset;
    if (extracted.limit) limit = extracted.limit;
  }

  const linesMatch = inputPath.match(/^(.+?)\s+lines?\s+(\d+)(?:-(\d+))?$/i);
  if (linesMatch) {
    inputPath = linesMatch[1].trim();
    const startLine = parseInt(linesMatch[2], 10);
    const endLine = linesMatch[3] ? parseInt(linesMatch[3], 10) : startLine;
    offset = startLine;
    limit = endLine - startLine + 1;
  }

  return { inputPath, offset, limit };
}

/** 调度侧只要路径：与 Read 工具同一份内嵌参数剥离（offset/limit 取值不影响 inputPath）。 */
export function stripEmbeddedPathParams(rawPath: string): string {
  return parseEmbeddedParams(rawPath, 1, 1).inputPath;
}
