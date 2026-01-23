// ============================================================================
// Status IPC Handlers - 状态相关的 IPC 通道
// ============================================================================

import { ipcMain, type BrowserWindow } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('StatusIPC');
const execAsync = promisify(exec);

// IPC 通道名常量
export const STATUS_CHANNELS = {
  GET_GIT_INFO: 'status:git-info',
  CHECK_NETWORK: 'status:network',
  TOKEN_UPDATE: 'status:token-update',
  COST_UPDATE: 'status:cost-update',
  CONTEXT_UPDATE: 'status:context-update',
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

      await fetch('https://api.deepseek.com/health', {
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

// 模型定价表（每 1000 tokens 的价格，单位：美元）
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 0.00014, output: 0.00028 },
  'deepseek-reasoner': { input: 0.00055, output: 0.00219 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-opus': { input: 0.015, output: 0.075 },
};

/**
 * 计算 API 调用费用
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string
): number {
  const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
  return (
    (inputTokens / 1000) * pricing.input +
    (outputTokens / 1000) * pricing.output
  );
}
