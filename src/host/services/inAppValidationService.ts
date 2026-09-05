// ============================================================================
// In-App Validation Service
// ----------------------------------------------------------------------------
// Main 进程驱动 renderer 端的 InAppValidationWorkspace（评测中心「验证」tab）跑一段 step 脚本，
// 通过 broadcastToRenderer 发请求、监听 IPC invoke 拿回结果。
// ============================================================================

import { randomUUID } from 'crypto';
import { broadcastToRenderer, hasRendererPushListener } from '../platform/windowBridge';
import { IPC_CHANNELS } from '../../shared/ipc';
import type {
  BrowserInteractionStep,
  BrowserInteractionStepResult,
  InAppValidationResultPayload,
} from '../../shared/contract/browserInteraction';

const DEFAULT_IN_APP_VALIDATION_TIMEOUT_MS = 30000;

/**
 * 没有渲染进程时的固定错误文案。
 *
 * 无头跑法（评测 CLI / 脚本）里没人收 IN_APP_VALIDATION_REQUEST，等下去只能等到超时，
 * 把「环境缺渲染进程」这件事拖成 30s 的沉默，再混进能力评测的时间预算里。
 * 立刻失败，让调用方（和模型）当场知道是环境不具备，而不是自己做错了什么。
 */
export const IN_APP_VALIDATION_UNAVAILABLE =
  'in-app validation panel is unavailable: no renderer attached (headless or eval run)';

interface PendingEntry {
  resolve: (results: BrowserInteractionStepResult[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/**
 * 请求 renderer panel 跑一段验证脚本。
 *
 * 注意：renderer 端由 useInAppValidationBridge 把请求引进评测中心「验证」tab 执行；
 * 用户若选择保留手动编辑会立即收到 error reject，否则等 timeoutMs 后超时 reject。
 */
export function runInAppValidation(
  html: string,
  steps: BrowserInteractionStep[],
  timeoutMs: number = DEFAULT_IN_APP_VALIDATION_TIMEOUT_MS,
): Promise<BrowserInteractionStepResult[]> {
  if (!hasRendererPushListener()) {
    return Promise.reject(new Error(IN_APP_VALIDATION_UNAVAILABLE));
  }
  const requestId = randomUUID();
  return new Promise<BrowserInteractionStepResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        reject(new Error(`in-app validation timed out after ${timeoutMs}ms (requestId=${requestId})`));
      }
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    broadcastToRenderer(IPC_CHANNELS.IN_APP_VALIDATION_REQUEST, {
      requestId,
      html,
      steps,
      timeoutMs,
    });
  });
}

/**
 * IPC handler 调用此函数把结果交付回 pending promise。
 */
export function handleInAppValidationResult(payload: InAppValidationResultPayload): void {
  const entry = pending.get(payload.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(payload.requestId);
  if (payload.error) {
    entry.reject(new Error(payload.error));
    return;
  }
  entry.resolve(payload.results ?? []);
}

/**
 * 仅供测试 / 调试用 — 查看当前还在等的请求数。
 */
export function getPendingInAppValidationCount(): number {
  return pending.size;
}
