// 项目记忆的仓库身份键（N-MEM-PROJECTKEY，爸 2026-09-30 拍板 A 方案：只合并记忆，
// Project/workspace_key/getProjectKey 与盘上存储全不动）。
// 键 = <git-common-dir 规范化路径>::<projectPath 相对仓顶的路径>：
//   - 同仓 worktree 的根目录同键（各自的 --show-toplevel 就是 worktree 根，相对路径为空）→ 共享分区；
//   - 仓内子目录（dotfiles 仓下的项目、monorepo 的 packages/a 与 b）相对路径不同 → 保持隔离
//     （PR#2177 ai-review Important：裸 common-dir 会让同仓子目录串味）。
// 非 git 目录、git 不可用、路径不存在一律回落 canonicalizeWorkspacePath，永不抛错。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalizeWorkspacePath } from '../runtime/workspaceScope';

const execFileAsync = promisify(execFile);

const GIT_REV_PARSE_TIMEOUT_MS = 3_000;
// git 解析成功的键进程内永久缓存（仓库身份不变）；非 git 回落值短 TTL，
// 避免一次 git 超时或事后 git init 让错误键活到进程重启（PR#2177 Nit）。
const FALLBACK_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  key: string;
  /** 仅回落值有：过期时间戳（ms）；git 键无此字段 = 永不过期 */
  expiresAt?: number;
}

const memoryKeyByPath = new Map<string, CacheEntry>();

function canonicalizeOrResolve(input: string): string {
  try {
    return canonicalizeWorkspacePath(input);
  } catch {
    return path.resolve(input);
  }
}

async function revParse(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', ...args], {
    cwd: projectPath,
    timeout: GIT_REV_PARSE_TIMEOUT_MS,
  });
  const value = stdout.trim();
  if (!value) throw new Error(`empty git rev-parse output: ${args.join(' ')}`);
  return value;
}

/** 仓内路径 → `<commonDir>::<相对仓顶路径>`；非 git / 任何 git 错误 → null。 */
async function resolveGitMemoryKey(projectPath: string): Promise<string | null> {
  try {
    const [commonDir, topLevel] = await Promise.all([
      revParse(projectPath, ['--git-common-dir']),
      revParse(projectPath, ['--show-toplevel']),
    ]);
    const relative = path.relative(canonicalizeOrResolve(topLevel), canonicalizeOrResolve(projectPath));
    return `${canonicalizeOrResolve(commonDir)}::${relative}`;
  } catch {
    return null;
  }
}

/** projectPath → 记忆分区键（同仓 worktree 根同键、仓内子目录隔离）。永不 reject。 */
export async function resolveProjectMemoryKey(projectPath: string): Promise<string> {
  const cached = memoryKeyByPath.get(projectPath);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
    return cached.key;
  }
  const gitKey = await resolveGitMemoryKey(projectPath);
  if (gitKey !== null) {
    memoryKeyByPath.set(projectPath, { key: gitKey });
    return gitKey;
  }
  const fallback = canonicalizeOrResolve(projectPath);
  memoryKeyByPath.set(projectPath, { key: fallback, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
  return fallback;
}
