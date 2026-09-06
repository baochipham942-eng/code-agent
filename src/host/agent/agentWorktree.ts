// ============================================================================
// Agent Worktree - 为 coder 子代理创建隔离的 Git 工作树
// ============================================================================
//
// 借鉴 Claude Code 的 worktree isolation 模式：
// - 每个 coder agent 在独立分支上工作，避免文件写冲突
// - 无变更时自动清理，有变更时保留供父 agent 决定如何合并
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';
import { captureWorkspacePatch } from '../services/checkpoint/taskPatchService';
import {
  makeEvidenceRef,
  type EvidenceRef,
} from '../../shared/contract/evidence';
import type {
  AgentTreeChangedFile,
  AgentWorktreeArtifact,
  AgentWorktreeReview,
} from '../../shared/contract/agentTree';
import { WORKTREE_BASE_DIR } from './agentWorktreePath';

const execAsync = promisify(exec);
const logger = createLogger('AgentWorktree');

const WORKTREE_TIMEOUT = 30_000;
const MAX_WORKTREE_DIFF_CHARS = 20_000;
const MAX_AGENT_REF_COMPONENT_BYTES = 120;
const ROLE_DEFAULT_ISOLATION: Record<string, 'worktree' | 'none'> = {
  coder: 'worktree',
  explorer: 'none',
  reviewer: 'none',
  planner: 'none',
  awaiter: 'none',
};

export async function resolveAgentWorktreeIsolation(input: {
  tools: string[];
  role?: string;
  explicit?: string;
  /**
   * 子 agent 的工作目录；探测**确认**非 git 仓库或零提交仓库（HEAD 无法解析）时
   * 隔离没有意义且必然失败，直接判 none。探测本身失败（git 不可执行/超时/仓库
   * 读取失败）不算「确认」，不降级——见 probeWorktreeBase。
   */
  cwd?: string;
  /**
   * 外部写执行器要求 Neo 管理的 worktree；非 git / 零提交场景也不允许降级，
   * 照常走 worktree（在创建处失败，worktreeFailureHint 给可读原因）。
   */
  forceWorktree?: boolean;
}): Promise<'worktree' | 'none'> {
  // 显式要求 worktree 的两个来源（外部引擎 / 调用方显式传参）同级，都在探测之前：
  // 显式要的隔离不允许被探测结果静默压掉，宁可照常 worktree 在创建处显式失败。
  if (input.forceWorktree || input.explicit === 'worktree') return 'worktree';
  if (input.cwd !== undefined) {
    const probe = await probeWorktreeBase(input.cwd);
    if (probe.kind === 'no-repo' || probe.kind === 'unborn') {
      logger.warn(
        `${input.cwd} 无法创建 worktree（不在 git 仓库内，或仓库还没有任何提交），子 agent 降级为无 worktree 隔离`,
      );
      return 'none';
    }
    if (probe.kind === 'unknown') {
      // fail-closed：只有「确认建不了」才允许降级。探测没结论时保持 worktree，
      // 否则可写子代理会在父工作目录里直接写文件（并发互相覆盖）。
      logger.warn(
        `${input.cwd} git 探测失败（${probe.reason}），不降级为无隔离；若仓库确实不可建 worktree，将在创建处失败并给出原因`,
      );
    }
  }
  if (input.tools.some((tool) => ['Write', 'Edit', 'Bash'].includes(tool))) {
    return 'worktree';
  }
  const roleDefault = ROLE_DEFAULT_ISOLATION[input.role ?? ''];
  if (roleDefault) return roleDefault;
  return 'none';
}

/**
 * worktree base 可用性的探测结论。
 * - `resolves`：HEAD 能解析为**存在的** commit，worktree 一定有 base 可指
 * - `no-repo`：**确认**不在 git 仓库内
 * - `unborn`：**确认**在 git 仓库内但还没有任何提交（HEAD 指向尚不出生的分支）
 * - `unknown`：探测本身失败（git 不可执行、超时、仓库元数据失效等），没有结论
 *
 * 只有前三种「确认」档才允许据此降级无隔离；`unknown` 不许降级（fail-closed）。
 */
type GitWorktreeBaseProbe =
  | { kind: 'resolves' }
  | { kind: 'no-repo' }
  | { kind: 'unborn' }
  | { kind: 'unknown'; reason: string };

/** 单条 git 探测命令的结局：只保留退出码与 stdout，stderr 一律不读（文本随 git 版本/locale 变）。 */
type GitProbeRun =
  | { ok: true; stdout: string }
  | { ok: false; exitCode: number | undefined; timedOut: boolean };

type GitProbeFailure = Extract<GitProbeRun, { ok: false }>;

async function runGitProbe(cwd: string, gitArgs: string): Promise<GitProbeRun> {
  try {
    const { stdout } = await execAsync(`git -C ${shellQuote(cwd)} ${gitArgs}`, {
      timeout: WORKTREE_TIMEOUT,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean };
    return {
      ok: false,
      exitCode: typeof e.code === 'number' ? e.code : undefined,
      timedOut: e.killed === true,
    };
  }
}

/** 探测进程本身没跑成（sh 找不到 git=127、不可执行=126、超时被杀、exec 级异常）——不是 git 的结论。只在 `!run.ok` 时有意义。 */
function isProbeProcessFailure(run: GitProbeFailure): boolean {
  return run.timedOut || run.exitCode === undefined || run.exitCode === 127 || run.exitCode === 126;
}

function probeProcessFailureReason(run: GitProbeFailure): string {
  if (run.timedOut) return `git 探测超时（>${WORKTREE_TIMEOUT}ms 被杀）`;
  if (run.exitCode === 127 || run.exitCode === 126) {
    return `git 不可执行（退出码 ${run.exitCode}）`;
  }
  return 'git 探测进程异常（无退出码）';
}

/**
 * 沿目录树向上找 `.git`（目录或 gitfile 都算），返回出现 `.git` 的那层目录，
 * 到根都没有则返回 undefined。git 在「向上找不到 .git」与「.git 在场但元数据失效
 * （gitdir 死引用/HEAD 损坏）」两种情形下退出码同为 128，退出码分不开——用这一
 * 文件系统结构事实来分：一路无 .git 才是「确认不在仓库里」。
 */
function findDotGitUp(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 用 git 自己的判据探测 worktree 能否有 base（`git worktree add` 需要可解析的 HEAD）。
 * worktree 隔离在非 git 目录下没有意义且必然失败——Neo 的协作者多数不是程序员，
 * 默认工作目录就是家目录，硬起隔离会让「派个会写文件的成员」整条路不可用；
 * 「git init 过但还没有任何提交」的仓库同属这一档。
 *
 * 判据全部来自**退出码 + 文件系统结构**，stderr 一个字节都不读：按 stderr 文本
 * 分类 git 失败原因是穷举型（文本随 git 版本、locale、挂载布局变，PR#1685
 * ai-review R1-R3 每轮都在同一点挖出新形态）。退出码语义 2026-09-06 本机实测
 * 定型（git 2.50.1，完整矩阵见证据档 N-SPAWN-NOHEAD）：
 *
 * 1. `rev-parse --verify --quiet 'HEAD^{commit}'` 退出 0 ⇒ `resolves`。
 *    peel 到 commit 会查对象库，悬空 sha（ref 指向不存在的对象）也拦在这一步。
 * 2. 失败时先问「在不在仓库里」（`rev-parse --git-dir`）：git 不认 ⇒ 自己沿
 *    目录树找 .git 佐证——一路无 .git ⇒ `no-repo`（跨挂载点措辞差异只影响
 *    stderr，退出码与文件系统结论一致）；.git 在场但 git 不认 ⇒ `unknown`。
 * 3. 在仓库内但 HEAD 解析不出 ⇒ `symbolic-ref -q HEAD` 问 HEAD 指哪：读不出
 *    （引用损坏，实测退出 128）⇒ `unknown`；读出目标 ref 后用 `show-ref <目标>`
 *    （不加 --verify/--quiet：这一形态下 absent=1 / 损坏=128 / 健在=0，实测可分）
 *    ——目标分支还没出生（退出 1）⇒ `unborn`；其余 ⇒ `unknown`。
 * 4. 探测进程本身失败（127/126、超时、exec 异常、cwd 不存在）⇒ `unknown`。
 */
async function probeWorktreeBase(dir: string): Promise<GitWorktreeBaseProbe> {
  const head = await runGitProbe(dir, `rev-parse --verify --quiet 'HEAD^{commit}'`);
  if (head.ok) return { kind: 'resolves' };
  if (isProbeProcessFailure(head)) {
    return { kind: 'unknown', reason: probeProcessFailureReason(head) };
  }

  const inside = await runGitProbe(dir, 'rev-parse --git-dir');
  if (!inside.ok && isProbeProcessFailure(inside)) {
    return { kind: 'unknown', reason: probeProcessFailureReason(inside) };
  }
  if (!inside.ok) {
    if (!fs.existsSync(dir)) {
      return { kind: 'unknown', reason: `工作目录不存在：${dir}` };
    }
    const dotGitOwner = findDotGitUp(dir);
    if (!dotGitOwner) return { kind: 'no-repo' };
    return {
      kind: 'unknown',
      reason: `${dotGitOwner} 下有 .git 但 git 无法识别（仓库元数据失效）`,
    };
  }

  const symref = await runGitProbe(dir, 'symbolic-ref -q HEAD');
  if (!symref.ok && isProbeProcessFailure(symref)) {
    return { kind: 'unknown', reason: probeProcessFailureReason(symref) };
  }
  if (!symref.ok) {
    return { kind: 'unknown', reason: 'HEAD 不是可读的符号引用（引用损坏或分离头损坏）' };
  }
  const targetRef = symref.stdout.trim();
  if (!targetRef.startsWith('refs/')) {
    return { kind: 'unknown', reason: `HEAD 指向非法引用：${targetRef || '(空)'}` };
  }
  // ref 名对 git 合法但对 shell 未必（$、括号都在 git 允许集内），必须整体加引号
  const target = await runGitProbe(dir, `show-ref ${shellQuote(targetRef)}`);
  if (!target.ok && isProbeProcessFailure(target)) {
    return { kind: 'unknown', reason: probeProcessFailureReason(target) };
  }
  if (target.ok) {
    return {
      kind: 'unknown',
      reason: `HEAD 解析不出但目标引用 ${targetRef} 健在（矛盾状态）`,
    };
  }
  if (target.exitCode === 1) {
    return { kind: 'unborn' };
  }
  return {
    kind: 'unknown',
    reason: `目标引用 ${targetRef} 损坏或悬空（show-ref 退出 ${target.exitCode}）`,
  };
}

/**
 * worktree 创建失败时的人话提示：区分「不在 git 仓库」和「在 git 仓库但还没有
 * 任何提交」。后者 git 原生报 "ambiguous argument 'HEAD'"，对用户没有指向性。
 * 探测无结论（unknown）时退回通用提示——创建失败的原始 stderr 已在错误信息里。
 */
export async function worktreeFailureHint(cwd: string): Promise<string> {
  if ((await probeWorktreeBase(cwd)).kind === 'unborn') {
    return '仓库还没有任何提交（HEAD 无法解析），无法创建 worktree；请先在仓库里做一次初始提交，或换 native 引擎的子代理。';
  }
  return 'Ensure you are in a git repository.';
}

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branchName: string;
  /** If changes exist, the worktree path is preserved */
  worktreePath?: string;
  changedFiles?: AgentTreeChangedFile[];
  diffSummary?: string;
}

const worktreeArtifacts = new Map<string, AgentWorktreeArtifact>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function isValidAgentWorktree(worktreePath: string): Promise<boolean> {
  if (!fs.existsSync(worktreePath)) return false;
  try {
    const { stdout } = await execAsync(
      `git -C ${shellQuote(worktreePath)} worktree list --porcelain`,
      { timeout: WORKTREE_TIMEOUT },
    );
    const expected = fs.realpathSync(worktreePath);
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .some((line) => {
        const candidate = line.slice('worktree '.length);
        try {
          return fs.realpathSync(candidate) === expected;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** Keep git ref/path components bounded even when the logical Team identity is composite. */
export function getAgentWorktreeKey(agentId: string): string {
  if (Buffer.byteLength(agentId, 'utf8') <= MAX_AGENT_REF_COMPONENT_BYTES) {
    return agentId;
  }
  const readableTail = agentId
    .slice(-32)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '') || 'agent';
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 24);
  return `${readableTail.slice(0, 32)}_${digest}`;
}

function cloneChangedFiles(files?: AgentTreeChangedFile[]): AgentTreeChangedFile[] | undefined {
  return files?.map((file) => ({ ...file }));
}

function cloneEvidenceRefs(refs?: EvidenceRef[]): EvidenceRef[] | undefined {
  return refs?.map((ref) => ({
    ...ref,
    freshness: { ...ref.freshness },
  }));
}

function cloneArtifact(artifact: AgentWorktreeArtifact): AgentWorktreeArtifact {
  return {
    ...artifact,
    ...(artifact.changedFiles ? { changedFiles: cloneChangedFiles(artifact.changedFiles) } : {}),
    ...(artifact.evidenceRefs ? { evidenceRefs: cloneEvidenceRefs(artifact.evidenceRefs) } : {}),
  };
}

function makeWorktreeEvidenceRef(agentId: string, worktreePath: string, kind: 'diff' | 'file'): EvidenceRef {
  return makeEvidenceRef({
    kind,
    ref: worktreePath,
    source: `agentWorktree:${agentId}`,
    state: 'fresh',
  });
}

function recordWorktreeArtifact(
  agentId: string,
  next: Omit<AgentWorktreeArtifact, 'agentId' | 'updatedAt'> & { updatedAt?: number },
): AgentWorktreeArtifact {
  const existing = worktreeArtifacts.get(agentId);
  const artifact: AgentWorktreeArtifact = {
    agentId,
    updatedAt: next.updatedAt ?? Date.now(),
    status: next.status,
    ...(next.path ? { path: next.path } : existing?.path ? { path: existing.path } : {}),
    ...(next.branch ? { branch: next.branch } : existing?.branch ? { branch: existing.branch } : {}),
    ...(next.repoPath ? { repoPath: next.repoPath } : existing?.repoPath ? { repoPath: existing.repoPath } : {}),
    ...(next.changedFiles ? { changedFiles: cloneChangedFiles(next.changedFiles) } : {}),
    ...(next.diffSummary ? { diffSummary: next.diffSummary } : {}),
    ...(next.evidenceRefs ? { evidenceRefs: cloneEvidenceRefs(next.evidenceRefs) } : {}),
    ...(next.error ? { error: next.error } : {}),
  };
  worktreeArtifacts.set(agentId, artifact);
  return cloneArtifact(artifact);
}

export function listAgentWorktreeArtifacts(): AgentWorktreeArtifact[] {
  return Array.from(worktreeArtifacts.values()).map(cloneArtifact);
}

export function getAgentWorktreeArtifact(agentId: string): AgentWorktreeArtifact | undefined {
  const artifact = worktreeArtifacts.get(agentId);
  return artifact ? cloneArtifact(artifact) : undefined;
}

export function resetAgentWorktreeArtifactsForTest(): void {
  worktreeArtifacts.clear();
}

export function parseGitStatusPorcelain(output: string): AgentTreeChangedFile[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const pathPart = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').pop() ?? rawPath
        : rawPath;
      const normalizedCode = code.replace(/\s/g, '');
      const status: AgentTreeChangedFile['status'] = normalizedCode.includes('?')
        ? 'untracked'
        : normalizedCode.includes('R')
          ? 'renamed'
          : normalizedCode.includes('C')
            ? 'copied'
            : normalizedCode.includes('A')
              ? 'added'
              : normalizedCode.includes('D')
                ? 'deleted'
                : normalizedCode.includes('M')
                  ? 'modified'
                  : 'unknown';
      return {
        path: pathPart.replace(/^"|"$/g, ''),
        status,
      };
    });
}

async function readChangedFiles(worktreePath: string): Promise<AgentTreeChangedFile[]> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} status --porcelain`,
    { timeout: WORKTREE_TIMEOUT }
  );
  return parseGitStatusPorcelain(stdout);
}

async function readDiffSummary(worktreePath: string): Promise<string> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} diff HEAD --stat 2>/dev/null || true`,
    { timeout: WORKTREE_TIMEOUT }
  );
  return stdout.trim();
}

async function readDiff(worktreePath: string): Promise<{ diff: string; truncated: boolean }> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} diff HEAD -- 2>/dev/null || true`,
    { timeout: WORKTREE_TIMEOUT, maxBuffer: MAX_WORKTREE_DIFF_CHARS * 2 }
  );
  const truncated = stdout.length > MAX_WORKTREE_DIFF_CHARS;
  return {
    diff: truncated
      ? `${stdout.slice(0, MAX_WORKTREE_DIFF_CHARS)}\n\n[变更内容较长，已截断。]`
      : stdout,
    truncated,
  };
}

export async function getAgentWorktreeReview(agentId: string): Promise<AgentWorktreeReview | undefined> {
  const artifact = worktreeArtifacts.get(agentId);
  if (!artifact) return undefined;
  const worktreePath = artifact.path;
  if (!worktreePath || artifact.status === 'cleaned') {
    return cloneArtifact(artifact);
  }

  try {
    const [changedFiles, diffSummary, diff] = await Promise.all([
      readChangedFiles(worktreePath),
      readDiffSummary(worktreePath),
      readDiff(worktreePath),
    ]);
    const evidenceRefs = [makeWorktreeEvidenceRef(agentId, worktreePath, 'diff')];
    const refreshed = recordWorktreeArtifact(agentId, {
      ...artifact,
      changedFiles,
      diffSummary,
      evidenceRefs,
      updatedAt: Date.now(),
    });
    return {
      ...refreshed,
      diff: diff.diff,
      truncated: diff.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refreshed = recordWorktreeArtifact(agentId, {
      ...artifact,
      status: 'error',
      error: message,
      updatedAt: Date.now(),
    });
    return refreshed;
  }
}

/**
 * Create an isolated git worktree for an agent.
 * Branch name: agent/{agentId}
 * Path: /tmp/code-agent-worktrees/{agentId}
 */
export async function createAgentWorktree(
  agentId: string,
  repoPath: string,
  baseBranch?: string
): Promise<WorktreeInfo> {
  const physicalAgentId = getAgentWorktreeKey(agentId);
  const branchName = `agent/${physicalAgentId}`;
  const safeName = physicalAgentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const worktreePath = path.join(WORKTREE_BASE_DIR, safeName);

  // Determine base: explicit param or current HEAD
  const base = baseBranch || 'HEAD';

  const { stdout: baseCommitOutput } = await execAsync(
    `git rev-parse ${shellQuote(base)}`,
    { cwd: repoPath, timeout: WORKTREE_TIMEOUT },
  );
  const baseCommit = baseCommitOutput.trim();
  const cmd = `git worktree add -b ${shellQuote(branchName)} ${shellQuote(worktreePath)} ${shellQuote(baseCommit)}`;
  logger.info(`[${agentId}] Creating worktree: ${cmd}`);

  try {
    await execAsync(cmd, { cwd: repoPath, timeout: WORKTREE_TIMEOUT });
  } catch (err) {
    recordWorktreeArtifact(agentId, {
      status: 'error',
      path: worktreePath,
      branch: branchName,
      repoPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.info(`[${agentId}] Worktree created at ${worktreePath} (branch: ${branchName})`);
  recordWorktreeArtifact(agentId, {
    status: 'active',
    path: worktreePath,
    branch: branchName,
    repoPath,
    evidenceRefs: [makeWorktreeEvidenceRef(agentId, worktreePath, 'file')],
  });

  // 共享主仓库的 gitignored 依赖目录（如 node_modules）到 worktree，避免每个并行 agent
  // 重新 npm install。best-effort：任一 symlink 失败只记 warning，不让 worktree 创建失败。
  await shareGitignoredDirs(agentId, repoPath, worktreePath);

  return { worktreePath, branchName, baseCommit };
}

/**
 * Parse the top-level plain directory entries from a .gitignore file.
 * Only handles bare directory-name entries (e.g. `node_modules/`, `dist`, `.next/`).
 * Skips entries that contain wildcards, path separators, negations, or that are
 * comments/blank — those are too complex to safely map to a single top-level dir.
 */
export function parseGitignoreTopLevelDirs(gitignoreContent: string): string[] {
  const dirs: string[] = [];
  for (const rawLine of gitignoreContent.split('\n')) {
    const line = rawLine.trim();
    // Skip blanks, comments, negations
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Skip anything with a glob char or an embedded path separator
    if (/[*?[\]]/.test(line)) continue;
    // Strip a single trailing slash (directory marker), then reject if a slash remains
    const stripped = line.endsWith('/') ? line.slice(0, -1) : line;
    if (!stripped || stripped.includes('/')) continue;
    dirs.push(stripped);
  }
  return dirs;
}

/**
 * Best-effort: symlink the main repo's gitignored top-level directories into the
 * new worktree so parallel agents reuse installed deps instead of re-installing.
 * Any single failure is logged as a warning and skipped — never throws.
 */
async function shareGitignoredDirs(
  agentId: string,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    const gitignorePath = path.join(repoPath, '.gitignore');
    let content: string;
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore (or unreadable) — nothing to share
      return;
    }

    const entries = parseGitignoreTopLevelDirs(content);
    for (const entry of entries) {
      const source = path.join(repoPath, entry);
      const target = path.join(worktreePath, entry);
      try {
        // Source must exist and be a directory
        const sourceStat = fs.statSync(source);
        if (!sourceStat.isDirectory()) continue;
        // Skip if the worktree already has this path (file or dir)
        if (fs.existsSync(target)) continue;
        fs.symlinkSync(source, target, 'dir');
        logger.debug(`[${agentId}] Shared gitignored dir via symlink: ${entry}`);
      } catch (err) {
        logger.warn(`[${agentId}] Failed to share gitignored dir '${entry}':`, err);
      }
    }
  } catch (err) {
    // Whole step is best-effort; never block worktree creation
    logger.warn(`[${agentId}] shareGitignoredDirs failed:`, err);
  }
}

/**
 * Cleanup an agent's worktree after execution.
 * - If no changes: remove worktree + delete branch
 * - If changes exist: keep worktree, return info for parent to decide
 */
export async function cleanupAgentWorktree(
  agentId: string,
  worktreePath: string,
  repoPath: string,
  baseCommit?: string,
): Promise<WorktreeCleanupResult> {
  const branchName = `agent/${getAgentWorktreeKey(agentId)}`;

  try {
    // Check for uncommitted changes in worktree
    const { stdout: statusOutput } = await execAsync(
      `git -C '${worktreePath}' status --porcelain`,
      { timeout: WORKTREE_TIMEOUT }
    );

    // Check diff against the parent branch point
    const diffBase = baseCommit ? shellQuote(baseCommit) : 'HEAD';
    const { stdout: diffOutput } = await execAsync(
      `git -C ${shellQuote(worktreePath)} diff ${diffBase} --stat 2>/dev/null || true`,
      { timeout: WORKTREE_TIMEOUT }
    );

    const { stdout: commitCountOutput } = baseCommit
      ? await execAsync(
        `git -C ${shellQuote(worktreePath)} rev-list --count ${shellQuote(baseCommit)}..HEAD`,
        { timeout: WORKTREE_TIMEOUT },
      )
      : { stdout: '0' };

    const hasChanges = statusOutput.trim().length > 0
      || diffOutput.trim().length > 0
      || Number.parseInt(commitCountOutput.trim(), 10) > 0;

    if (!hasChanges) {
      // No changes — clean up
      await execAsync(
        `git worktree remove '${worktreePath}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      );
      await execAsync(
        `git branch -d '${branchName}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      ).catch(() => {
        // Branch delete may fail if already deleted, ignore
      });
      recordWorktreeArtifact(agentId, {
        status: 'cleaned',
        branch: branchName,
        repoPath,
        changedFiles: [],
        diffSummary: '',
      });
      logger.info(`[${agentId}] Worktree cleaned up (no changes)`);
      return { hasChanges: false, branchName, changedFiles: [], diffSummary: '' };
    }

    // Has changes — capture a patch safety net, then preserve worktree for
    // the parent to review/merge. The patch means the changes survive even if
    // the worktree is later force-removed (orphan cleanup / crash).
    // best-effort: capture failure never blocks cleanup.
    try {
      await captureWorkspacePatch(worktreePath, agentId, 'worktree-cleanup');
    } catch (err) {
      logger.warn(`[${agentId}] captureWorkspacePatch failed during cleanup:`, err);
    }
    recordWorktreeArtifact(agentId, {
      status: 'preserved',
      path: worktreePath,
      branch: branchName,
      repoPath,
      changedFiles: parseGitStatusPorcelain(statusOutput),
      diffSummary: diffOutput.trim(),
      evidenceRefs: [makeWorktreeEvidenceRef(agentId, worktreePath, 'diff')],
    });
    logger.info(`[${agentId}] Worktree preserved (has changes) at ${worktreePath}`);
    return {
      hasChanges: true,
      branchName,
      worktreePath,
      changedFiles: parseGitStatusPorcelain(statusOutput),
      diffSummary: diffOutput.trim(),
    };
  } catch (err) {
    logger.warn(`[${agentId}] Worktree cleanup error:`, err);
    // On error, try force removal to avoid leaked worktrees
    try {
      await execAsync(
        `git worktree remove --force '${worktreePath}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      );
      await execAsync(
        `git branch -D '${branchName}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      ).catch(() => {});
    } catch {
      // Best effort cleanup
    }
    recordWorktreeArtifact(agentId, {
      status: 'error',
      path: worktreePath,
      branch: branchName,
      repoPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasChanges: false, branchName };
  }
}

/**
 * Cancel 路径专用：不保留临时 worktree，也不生成可能携带凭据的 checkpoint patch。
 * 只删除本 agent 的 worktree/branch，永不 merge 或触碰主工作区内容。
 */
export async function discardAgentWorktree(
  agentId: string,
  worktreePath: string,
  repoPath: string,
): Promise<void> {
  const branchName = `agent/${getAgentWorktreeKey(agentId)}`;
  await execAsync(
    `git worktree remove --force ${shellQuote(worktreePath)}`,
    { cwd: repoPath, timeout: WORKTREE_TIMEOUT },
  );
  await execAsync(
    `git branch -D ${shellQuote(branchName)}`,
    { cwd: repoPath, timeout: WORKTREE_TIMEOUT },
  ).catch(() => undefined);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Failed to remove cancelled agent worktree: ${worktreePath}`);
  }
  recordWorktreeArtifact(agentId, {
    status: 'cleaned',
    branch: branchName,
    repoPath,
    changedFiles: [],
    diffSummary: '',
  });
}

/**
 * Clean up orphaned worktrees left behind by crashed agents.
 * Finds worktrees in /tmp/code-agent-worktrees/ older than maxAgeMs
 * that don't have an associated running process.
 *
 * @param repoPath - The main repository path
 * @param maxAgeMs - Maximum age before cleanup (default 1 hour)
 * @returns Number of cleaned up worktrees
 */
export async function cleanupOrphanedWorktrees(
  repoPath: string,
  maxAgeMs = 3_600_000
): Promise<number> {
  let cleaned = 0;

  try {
    // 1. List all worktrees via git
    const { stdout } = await execAsync(
      'git worktree list --porcelain',
      { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
    );

    // 2. Parse worktree entries — each block starts with "worktree <path>"
    const entries = stdout.split('\n\n').filter(block => block.trim());
    const now = Date.now();

    // `git worktree list` reports resolved real paths; on macOS the managed base
    // dir (/tmp/...) resolves to /private/tmp/... So match against both the literal
    // base dir and its realpath, otherwise orphan cleanup is a no-op on macOS.
    const baseDirCandidates = [WORKTREE_BASE_DIR];
    try {
      const real = fs.realpathSync(WORKTREE_BASE_DIR);
      if (real !== WORKTREE_BASE_DIR) baseDirCandidates.push(real);
    } catch {
      // base dir may not exist yet — literal prefix is enough
    }

    for (const entry of entries) {
      const pathMatch = entry.match(/^worktree\s+(.+)$/m);
      const branchMatch = entry.match(/^branch\s+refs\/heads\/(.+)$/m);
      if (!pathMatch) continue;

      const wtPath = pathMatch[1];
      const branchName = branchMatch?.[1];

      // 3. Only clean worktrees in our managed directory
      if (!baseDirCandidates.some(base => wtPath.startsWith(base))) continue;

      // 4. Check directory mtime
      try {
        const stat = fs.statSync(wtPath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue;
      } catch {
        // Directory doesn't exist on disk — git still references it, force remove
      }

      // 5. Capture a patch before force-removing, so any uncommitted work in a
      //    stale/orphaned worktree isn't silently lost. best-effort; if the
      //    worktree dir is already gone captureWorkspacePatch returns null.
      const orphanAgentId = branchName?.startsWith('agent/')
        ? branchName.slice('agent/'.length)
        : path.basename(wtPath);
      try {
        await captureWorkspacePatch(wtPath, orphanAgentId, 'worktree-cleanup');
      } catch (err) {
        logger.warn(`[OrphanCleanup] captureWorkspacePatch failed for ${wtPath}:`, err);
      }

      // 6. Remove the orphaned worktree
      try {
        await execAsync(
          `git worktree remove --force '${wtPath}'`,
          { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
        );
        // Delete the associated branch if it follows agent/* naming
        if (branchName?.startsWith('agent/')) {
          await execAsync(
            `git branch -D '${branchName}'`,
            { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
          ).catch(() => {});
        }
        cleaned++;
        logger.info(`[OrphanCleanup] Removed orphaned worktree: ${wtPath}`);
      } catch (err) {
        logger.warn(`[OrphanCleanup] Failed to remove ${wtPath}:`, err);
      }
    }
  } catch (err) {
    // Best-effort: don't crash if git worktree list fails (e.g. not a git repo)
    logger.debug('[OrphanCleanup] Skipped:', err);
  }

  return cleaned;
}
