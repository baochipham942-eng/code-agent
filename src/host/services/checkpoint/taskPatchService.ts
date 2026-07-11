// ============================================================================
// taskPatchService —— 任务取消/丢弃前的 workspace patch 快照
// ============================================================================
//
// fileCheckpointService 只覆盖 Prompt Rewind（工具执行前逐文件快照），无法在
// 「取消子代理 / 取消 workflow run / 清理 worktree」这类整体丢弃场景里抢救改动。
// 本服务在丢弃前把工作目录的全量 git 改动（tracked diff + untracked 文件）导出成
// 一个可 `git apply` 还原的 patch，落到 ~/.code-agent/trashed-task-patches/。
//
// best-effort：非 git 目录 / 无改动 / git 不可用 → 返回 null 不抛错，绝不阻塞取消。
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { NETWORK_TOOL_TIMEOUTS, TASK_PATCH } from '../../../shared/constants';
import { createLogger } from '../infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('TaskPatchService');

const GIT_TIMEOUT = NETWORK_TOOL_TIMEOUTS.GIT_OPERATION;
// 单个 untracked 文件的 diff 缓冲上限；二进制大文件可能很大，给足空间避免 maxBuffer 抛错
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const PATCH_CREDENTIAL_PATTERN = /(?:\bsk-[A-Za-z0-9._-]{5,}|\bAIza[0-9A-Za-z_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[-_]?key|token|secret|password|passwd|authorization|credential|private[-_]?key)\b\s*[=:]\s*\S+)/i;

export type TaskPatchReason = 'cancel' | 'delete' | 'worktree-cleanup';

/** patch 文件落地目录：~/.code-agent/trashed-task-patches/ */
export function getTrashedPatchDir(): string {
  return path.join(getUserConfigDir(), TASK_PATCH.TRASH_DIR);
}

/** 判断目录是否在 git 工作区内。 */
async function isGitRepo(workingDir: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', {
      cwd: workingDir,
      timeout: GIT_TIMEOUT,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** 取当前 HEAD 短 hash；失败（如空仓库无 commit）返回 'nohead'。 */
async function getHeadShortHash(workingDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD', {
      cwd: workingDir,
      timeout: GIT_TIMEOUT,
    });
    return stdout.trim() || 'nohead';
  } catch {
    return 'nohead';
  }
}

/**
 * 抓取 workingDir 的全量改动并合并成一个 patch 文本。
 * - tracked 改动：`git diff --binary HEAD`
 * - untracked 文件：`git ls-files --others --exclude-standard` 列出后逐个
 *   `git diff --binary --no-index /dev/null <file>`（exit code 1 = 有差异，非错误）
 * 无任何改动时返回空串。
 */
async function collectWorkspacePatch(workingDir: string): Promise<string> {
  let combined = '';

  // 1. tracked 改动
  try {
    const { stdout } = await execAsync('git diff --binary HEAD', {
      cwd: workingDir,
      timeout: GIT_TIMEOUT,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    if (stdout) combined += stdout;
  } catch (err) {
    // 空仓库（无 HEAD）时 `git diff HEAD` 会失败；退化为对 index 的 diff
    try {
      const { stdout } = await execAsync('git diff --binary', {
        cwd: workingDir,
        timeout: GIT_TIMEOUT,
        maxBuffer: EXEC_MAX_BUFFER,
      });
      if (stdout) combined += stdout;
    } catch {
      logger.debug('git diff HEAD failed', { workingDir, err });
    }
  }

  // 2. untracked 文件
  try {
    const { stdout: listOut } = await execAsync(
      'git ls-files --others --exclude-standard',
      { cwd: workingDir, timeout: GIT_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER },
    );
    const files = listOut.split('\n').map((f) => f.trim()).filter(Boolean);
    for (const file of files) {
      try {
        // --no-index 在有差异时以 exit code 1 退出，execAsync 会 reject；
        // 但 stdout 仍带着我们要的 diff，从 error 对象里取。
        const { stdout } = await execAsync(
          `git diff --binary --no-index /dev/null '${file.replace(/'/g, "'\\''")}'`,
          { cwd: workingDir, timeout: GIT_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER },
        );
        if (stdout) combined += stdout;
      } catch (err) {
        const e = err as { code?: number; stdout?: string };
        if (e && typeof e.stdout === 'string' && e.stdout) {
          combined += e.stdout;
        } else {
          logger.debug('untracked diff failed', { file });
        }
      }
    }
  } catch (err) {
    logger.debug('git ls-files failed', { workingDir, err });
  }

  return combined;
}

/**
 * 在 workingDir 抓取全量改动，写入一个可 `git apply` 还原的 patch 文件。
 *
 * @returns 写入的 patch 文件绝对路径；非 git 目录 / 无改动 / 失败 → null（不抛错、不写空文件）
 */
export async function captureWorkspacePatch(
  workingDir: string,
  taskId: string,
  reason: TaskPatchReason,
): Promise<string | null> {
  try {
    if (!workingDir || !fsSync.existsSync(workingDir)) return null;
    if (!(await isGitRepo(workingDir))) return null;

    const patchBody = await collectWorkspacePatch(workingDir);
    if (!patchBody.trim()) {
      // 没有任何改动 — 不写空文件
      return null;
    }
    if (PATCH_CREDENTIAL_PATTERN.test(patchBody)) {
      logger.warn('Skipped workspace patch because it may contain credentials', {
        taskId,
        reason,
      });
      return null;
    }

    const headHash = await getHeadShortHash(workingDir);
    const timestamp = Date.now();
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');

    const dir = getTrashedPatchDir();
    await fs.mkdir(dir, { recursive: true });

    const fileName = `${safeTaskId}-${headHash}-${timestamp}.patch`;
    const filePath = path.join(dir, fileName);

    // 头部注释行：恢复前 `git apply` 时可先确认元信息
    const header =
      `# code-agent trashed task patch\n` +
      `# taskId: ${taskId}\n` +
      `# reason: ${reason}\n` +
      `# head: ${headHash}\n` +
      `# capturedAt: ${new Date(timestamp).toISOString()}\n` +
      `# workingDir: ${workingDir}\n` +
      `#\n`;

    await fs.writeFile(filePath, header + patchBody, 'utf-8');
    logger.info('Captured workspace patch before discard', {
      taskId,
      reason,
      filePath,
    });
    return filePath;
  } catch (err) {
    logger.warn('captureWorkspacePatch failed', { taskId, reason, err });
    return null;
  }
}
