import fs from 'node:fs';
import path from 'node:path';

const EVAL_ANSWERS_ENV = 'NEO_EVAL_ANSWERS_DIR';

export interface ResolvedAnswerSideFile {
  answerRoot: string;
  answerFile: string;
  repoRoot: string;
  source: string;
}

function existingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Find the owning Git repository without invoking Git (worktree .git files count). */
export function findRepositoryRoot(fromPath: string): string | null {
  let current = path.resolve(fromPath);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    return null;
  }

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function answerSideCandidates(repoRoot: string): string[] {
  // ponytail: 兄弟目录名硬编码是约定，ADR-038 点名了这个路径；换位置改 env。
  return [
    path.resolve(repoRoot, '..', 'code-agent-private-archive', 'eval'),
    path.resolve(repoRoot, '..', '..', 'code-agent-private-archive', 'eval'),
  ];
}

export function resolveAnswerSideRoot(fromPath: string): string | null {
  const repoRoot = findRepositoryRoot(fromPath);
  if (!repoRoot) return null;

  const configured = process.env[EVAL_ANSWERS_ENV]?.trim();
  if (configured === 'none') return null;
  if (configured) {
    const answerRoot = path.resolve(configured);
    if (!existingDirectory(answerRoot)) {
      throw new Error(`${EVAL_ANSWERS_ENV} 指向的答案目录不存在: ${answerRoot}`);
    }
    return answerRoot;
  }

  return answerSideCandidates(repoRoot).find(existingDirectory) ?? null;
}

function canonicalPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 公开题面相对仓库根的路径（'/' 分隔），是答案侧文件的 key。
 * 先 realpath 再取相对：题库目录是软链时（主仓 .code-agent/test-cases -> .claude/test-cases）
 * 按软链路径取会得到 .code-agent/…，私档里没有这个 key，整套题全成 not_run。
 */
export function repoRelativeSource(repoRoot: string, filePath: string): string | null {
  const relative = path.relative(canonicalPath(repoRoot), canonicalPath(filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

export function resolveAnswerSideFile(yamlPath: string): ResolvedAnswerSideFile | null {
  const repoRoot = findRepositoryRoot(yamlPath);
  if (!repoRoot) return null;
  const answerRoot = resolveAnswerSideRoot(repoRoot);
  if (!answerRoot) return null;

  const source = repoRelativeSource(repoRoot, yamlPath);
  if (!source) return null;
  return {
    answerRoot,
    answerFile: path.join(answerRoot, 'answers', ...source.split('/')),
    repoRoot,
    source,
  };
}
