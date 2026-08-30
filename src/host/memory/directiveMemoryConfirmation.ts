import { randomUUID } from 'crypto';
import { MEMORY_TIMEOUTS } from '../../shared/constants';
import type { MemoryConfirmRequest } from '../../shared/contract/memory';
import type { PermissionRequestData } from '../tools/types';
import type { RequestPermissionResult } from '../../shared/contract/permission';
import { normalizePermissionAskResult } from '../../shared/contract/permission';
import { IPC_CHANNELS } from '../../shared/ipc';
import { broadcastToRenderer, hasInteractiveUi } from '../platform/windowBridge';

interface PendingDirectiveConfirmation {
  resolve: (result: DirectiveMemoryConfirmationResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DirectiveMemoryConfirmationResult {
  requestId: string;
  confirmed: boolean;
  respondedAt: number;
  /** true = 确认窗口超时自动关闭（用户可能没看到）；false = 用户明确点了确认/拒绝 */
  timedOut: boolean;
  /** true = 运行环境没有交互界面（CLI/headless），确认门 fail-fast 立即关闭，没有等窗口 */
  headlessNoUi?: boolean;
}

const pending = new Map<string, PendingDirectiveConfirmation>();

export async function requestDirectiveMemoryConfirmation(input: {
  content: string;
  category: string;
}): Promise<DirectiveMemoryConfirmationResult> {
  const id = `directive-${randomUUID()}`;

  // headless/非交互（CLI run、无活跃 renderer 的 web）：确认窗永远等不到回答，
  // 不能让调用方挂满 DIRECTIVE_CONFIRM（120s）——fail-fast 并打标，文案分流见
  // directiveMemoryMessages.ts。skip-permissions 的放行在 toolExecutor 确认门上游处理。
  if (!hasInteractiveUi()) {
    return { requestId: id, confirmed: false, respondedAt: Date.now(), timedOut: false, headlessNoUi: true };
  }

  const request: MemoryConfirmRequest = {
    id,
    content: input.content,
    category: input.category,
    type: 'directive',
    authority: 'directive',
    confidence: 1,
    timestamp: Date.now(),
  };

  return new Promise<DirectiveMemoryConfirmationResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ requestId: id, confirmed: false, respondedAt: Date.now(), timedOut: true });
    }, MEMORY_TIMEOUTS.DIRECTIVE_CONFIRM);
    pending.set(id, { resolve, timer });
    broadcastToRenderer(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST, request);
  });
}

export function respondToDirectiveMemoryConfirmation(id: string, confirmed: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve({ requestId: id, confirmed, respondedAt: Date.now(), timedOut: false });
  return true;
}

export function assertDirectivePersistenceAuthorized(
  memoryType: string,
  explicitlyConfirmed: boolean,
): void {
  if (memoryType === 'directive' && !explicitlyConfirmed) {
    throw new Error('Directive memory requires explicit user confirmation.');
  }
}

export function clearDirectiveMemoryConfirmationsForTest(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}

/**
 * headless 探针的等待上限：skip-permissions / devModeAutoApprove / scripted 这些
 * 能「自己回答」的处理器都是同步返回；会挂起的（web 停车审批、无 UI 的 60s 超时
 * 定时器）都是在等一个不存在的人来点——那些场景必须 fail-fast，不能拿 run 的
 * 时间去陪等（原 bug 就是挂 120s 后模型重试风暴）。
 */
export const HEADLESS_PERMISSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * headless 下询问 run 级权限处理器「这次全局记忆写入是否被策略放行」。
 * - 同步可答的处理器（CLI skip / devModeAutoApprove / scripted）：按其结果放行或拒绝；
 * - 超时未答（在等人类通道）：按拒绝处理，返回 undefined 让调用方 fail-fast。
 *   迟到的 resolve 被丢弃，无副作用（审批侧有自己的超时清理）。
 */
export async function probeHeadlessPermission(
  requestPermission: (request: PermissionRequestData) => Promise<RequestPermissionResult>,
  request: PermissionRequestData,
  timeoutMs: number = HEADLESS_PERMISSION_PROBE_TIMEOUT_MS,
): Promise<ReturnType<typeof normalizePermissionAskResult> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestPermission(request).then((result) => normalizePermissionAskResult(result)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
