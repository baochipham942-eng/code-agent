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

export function resolveAnswerSideFile(yamlPath: string): ResolvedAnswerSideFile | null {
  const repoRoot = findRepositoryRoot(yamlPath);
  if (!repoRoot) return null;
  const answerRoot = resolveAnswerSideRoot(repoRoot);
  if (!answerRoot) return null;

  const relative = path.relative(repoRoot, path.resolve(yamlPath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  const source = relative.split(path.sep).join('/');
  return {
    answerRoot,
    answerFile: path.join(answerRoot, 'answers', ...source.split('/')),
    repoRoot,
    source,
  };
}
