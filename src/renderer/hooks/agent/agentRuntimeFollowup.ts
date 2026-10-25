// sendMessage 运行态辅助：busy/cancelling 判定、发送失败文案、durable-run 冷启动等待、
// 会话绑定与 cancel 收敛（从 useAgentIPC 抽出，纯函数搬移，无逻辑改动）。
import type { ConversationEnvelopeContext, RuntimeInputMode } from '@shared/contract/conversationEnvelope';
import { useAppStore } from '../../stores/appStore';
import type { SessionStatus as TaskSessionStatus } from '../../stores/taskStore';
import { useSessionStore } from '../../stores/sessionStore';
import { environmentProtocolUnsupportedMessage } from '../../i18n/executionEnvironment';
import { getApiBaseUrl } from '../../api/transport';

export function isRuntimeBusyStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'running'
    || status === 'paused'
    || status === 'queued';
}

export function isRuntimeCancellingStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'cancelling';
}

export function markLatestUserMessageRunCancelled(cancelledAt: number): void {
  const sessionStore = useSessionStore.getState();
  const latestUser = [...sessionStore.messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.isMeta);
  if (!latestUser) return;

  sessionStore.updateMessage(latestUser.id, {
    metadata: {
      ...latestUser.metadata,
      workbench: {
        ...latestUser.metadata?.workbench,
        runCancellation: {
          status: 'cancelled',
          cancelledAt,
          reason: 'user_cancelled',
        },
      },
    },
  });
}

export function getAgentSendFailureMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const message = raw.trim();
  // ADR-081 协议版本闸：宿主只回稳定码，用户可见句子由 i18n 给，不透传原始报错。
  return environmentProtocolUnsupportedMessage(error, useAppStore.getState().language)
    ?? (message
      ? `Error: ${message}`
      : 'Error: 消息发送失败，但前端没有收到具体错误。请查看后台日志。');
}

export function getRuntimeInputMode(context?: ConversationEnvelopeContext): RuntimeInputMode {
  return context?.runtimeInput?.mode === 'redirect' ? 'redirect' : 'supplement';
}

/**
 * 「这个 session 还有一轮没收干净」——host 的 RunSessionConflictError 经 HTTP 出来是 409。
 *
 * 它不是失败：模型上一轮已经答完了（用户也看到了），只是 agent_complete 到流关闭之间
 * 还有几秒收尾，run 仍占着 session。撞上这几秒的消息应该排队等下一轮，而不是给用户
 * 弹一条「云端代理请求失败」——真机 2026-08-01：回复答完 3 秒后发下一条就撞上。
 */
export function isSessionBusyRunConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { status?: unknown }).status === 409) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('already has active run');
}

const DURABLE_RUN_ROLLOUT_UNAVAILABLE = 'DURABLE_RUN_ROLLOUT_UNAVAILABLE';
const DURABLE_RUN_READY_TIMEOUT_MS = 90_000;
const DURABLE_RUN_READY_POLL_INTERVAL_MS = 1_000;

type DurableRunHealth = { durableRunReady?: unknown };

function isDurableRunHealth(value: unknown): value is DurableRunHealth {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isDurableRunRolloutUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const httpError = error as { status?: unknown; code?: unknown };
  return httpError.status === 503 && httpError.code === DURABLE_RUN_ROLLOUT_UNAVAILABLE;
}

export async function waitForDurableRunReady(): Promise<boolean> {
  const deadline = Date.now() + DURABLE_RUN_READY_TIMEOUT_MS;
  const healthUrl = `${getApiBaseUrl().replace(/\/+$/, '')}/api/health`;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
      if (response.ok) {
        const health = await response.json() as unknown;
        if (isDurableRunHealth(health) && health.durableRunReady === true) {
          return true;
        }
      }
    } catch {
      // The run endpoint just reported its cold-start gate. Keep polling until the bounded deadline.
    } finally {
      clearTimeout(abortTimer);
    }

    const nextWaitMs = Math.min(DURABLE_RUN_READY_POLL_INTERVAL_MS, deadline - Date.now());
    if (nextWaitMs <= 0) return false;
    await waitFor(nextWaitMs);
  }
}

/**
 * Resolve the session a send should bind to.
 * Awaits in-flight createSession so messages land on the new session the user just requested,
 * not the pre-create currentSessionId (cancel-chain B4 race).
 */
export async function resolveEffectiveSessionIdForSend(input: {
  envelopeSessionId?: string | null;
  getCurrentSessionId: () => string | null;
  getPendingSessionCreate: () => Promise<{ id: string } | null> | null;
  createFallbackSession: () => Promise<{ id: string } | null>;
  now?: () => number;
}): Promise<string> {
  const pendingCreate = input.getPendingSessionCreate();
  if (pendingCreate) {
    const created = await pendingCreate;
    if (input.envelopeSessionId) {
      return input.envelopeSessionId;
    }
    if (created) {
      return created.id;
    }
  }

  // A failed in-flight create leaves currentSessionId pointing at the session
  // visible before the user clicked New. Never silently send there: create a
  // fallback target instead. With no pending create, the current session is valid.
  let effectiveSessionId = input.envelopeSessionId
    ?? (pendingCreate ? null : input.getCurrentSessionId());
  if (!effectiveSessionId) {
    const created = await input.createFallbackSession();
    if (created) {
      effectiveSessionId = created.id;
    } else {
      const tempId = `web-session-${(input.now ?? Date.now)()}`;
      effectiveSessionId = tempId;
    }
  }
  return effectiveSessionId;
}

export interface CancelSettlementResponse {
  message?: string;
  runId?: string;
  sessionId?: string;
}

/**
 * Keep re-delivering a 202 cancel request until either the route confirms the
 * same run settled or the terminal SSE event has already converged renderer state.
 */
export async function requestCancelUntilSettled(input: {
  sessionId: string;
  requestCancel: (selector: { runId?: string; sessionId?: string }) => Promise<CancelSettlementResponse | undefined>;
  isCancellationActive: () => boolean;
  wait: () => Promise<void>;
}): Promise<boolean> {
  let selector: { runId?: string; sessionId?: string } = { sessionId: input.sessionId };

  while (true) {
    const result = await input.requestCancel(selector);
    if (result?.message !== 'cancel_requested') {
      return true;
    }

    // Retrying by session could cancel a follow-up run that starts after the
    // original one settles. A3 responses include runId so retries stay fenced.
    if (!result.runId) {
      return false;
    }
    selector = {
      runId: result.runId,
      sessionId: result.sessionId ?? input.sessionId,
    };

    await input.wait();
    if (!input.isCancellationActive()) {
      return false;
    }
  }
}
