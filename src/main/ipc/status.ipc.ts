// ============================================================================
// Status IPC Handlers - 状态相关的 IPC 通道
// ============================================================================

import { ipcMain, type BrowserWindow } from '../platform';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../services/infra/logger';
import { MODEL_PRICING_PER_1M, MODEL_API_ENDPOINTS, DEFAULT_PROVIDER } from '../../shared/constants';

const logger = createLogger('StatusIPC');
const execAsync = promisify(exec);

// IPC 通道名常量
export const STATUS_CHANNELS = {
  GET_GIT_INFO: 'status:git-info',
  CHECK_NETWORK: 'status:network',
  TOKEN_UPDATE: 'status:token-update',
  COST_UPDATE: 'status:cost-update',
  CONTEXT_UPDATE: 'status:context-update',
  GIT_CHANGES_UPDATE: 'status:git-changes-update',
} as const;

/**
 * 注册状态相关的 IPC handlers
 */
export function registerStatusHandlers(): void {
  // 获取 Git 信息
  ipcMain.handle(STATUS_CHANNELS.GET_GIT_INFO, async (_, workingDir: string) => {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: workingDir,
        timeout: 5000,
      });
      return { branch: stdout.trim(), workingDir };
    } catch {
      // 非 Git 目录或 git 命令失败
      return { branch: null, workingDir };
    }
  });

  // 网络状态检测
  ipcMain.handle(STATUS_CHANNELS.CHECK_NETWORK, async () => {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const providerEndpointMap: Record<string, keyof typeof MODEL_API_ENDPOINTS> = {
        moonshot: 'kimiK25',
        claude: 'claude',
        deepseek: 'deepseek',
      };
      const healthUrl = MODEL_API_ENDPOINTS[providerEndpointMap[DEFAULT_PROVIDER] || 'deepseek'];
      await fetch(healthUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const latency = Date.now() - start;

      if (latency > 2000) return 'slow';
      return 'online';
    } catch {
      return 'offline';
    }
  });

  logger.info('Status handlers registered');
}

/**
 * 发送 Token 使用更新到渲染进程
 */
export function sendTokenUpdate(
  window: BrowserWindow | null,
  inputTokens: number,
  outputTokens: number
): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(STATUS_CHANNELS.TOKEN_UPDATE, {
      inputTokens,
      outputTokens,
    });
  }
}

/**
 * 发送费用更新到渲染进程
 */
export function sendCostUpdate(window: BrowserWindow | null, cost: number): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(STATUS_CHANNELS.COST_UPDATE, { cost });
  }
}

/**
 * 发送上下文使用更新到渲染进程
 */
export function sendContextUpdate(window: BrowserWindow | null, percent: number): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(STATUS_CHANNELS.CONTEXT_UPDATE, { percent });
  }
}

/**
 * 获取 Git 变更统计（非阻塞）
 */
export async function getGitChanges(workingDir: string): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: workingDir,
      timeout: 5000,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return { staged: 0, unstaged: 0, untracked: 0 };

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;

    for (const line of lines) {
      const index = line[0];
      const worktree = line[1];
      if (index === '?' && worktree === '?') {
        untracked++;
      } else {
        if (index !== ' ' && index !== '?') staged++;
        if (worktree !== ' ' && worktree !== '?') unstaged++;
      }
    }

    return { staged, unstaged, untracked };
  } catch {
    return null;
  }
}

/**
 * 发送 Git 变更统计到渲染进程
 */
export function sendGitChangesUpdate(
  window: BrowserWindow | null,
  changes: { staged: number; unstaged: number; untracked: number } | null
): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(STATUS_CHANNELS.GIT_CHANGES_UPDATE, { changes });
  }
}

/**
 * 发送完整 Git 信息（branch + changes）到渲染进程
 */
export async function refreshGitStatus(
  window: BrowserWindow | null,
  workingDir: string
): Promise<void> {
  if (!window || window.isDestroyed()) return;

  try {
    const [branchResult, changes] = await Promise.all([
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd: workingDir, timeout: 5000 })
        .then(({ stdout }) => stdout.trim())
        .catch(() => null),
      getGitChanges(workingDir),
    ]);

    // Send branch info
    window.webContents.send(STATUS_CHANNELS.GET_GIT_INFO, {
      branch: branchResult,
      workingDir,
    });

    // Send changes
    sendGitChangesUpdate(window, changes);
  } catch (error) {
    logger.debug('Failed to refresh git status', { error });
  }
}

// Convert per-1M pricing to per-1K for this module
const MODEL_PRICING_PER_1K = Object.fromEntries(
  Object.entries(MODEL_PRICING_PER_1M).map(([k, v]) => [k, { input: v.input / 1000, output: v.output / 1000 }])
);

/**
 * 计算 API 调用费用
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string
): number {
  const pricing = MODEL_PRICING_PER_1K[model] || { input: 0, output: 0 };
  return (
    (inputTokens / 1000) * pricing.input +
    (outputTokens / 1000) * pricing.output
  );
}
