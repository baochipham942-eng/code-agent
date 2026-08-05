// ============================================================================
// promptUserInChat — 共享「会话内交互」round-trip（Slice A 地基）
//
// 抽自 AskUserQuestion（src/host/tools/modules/planning/askUserQuestion.ts）的
// IPC round-trip，供任意 tool 内部复用（成本确认等）。复用同一条
// USER_QUESTION_ASK/RESPONSE 通道 + 同一个 pending map + 同一个 once-guard
// handler，渲染层无需区分来源。electron / web(SSE) 共用 platform 抽象。
//
// 调用方语义：
// - no-renderer：CLI/headless 无浏览器连接 → 调用方决定 fallback（成本确认=不花钱）
// - answered：拿到用户选择
// - declined：用户主动拒绝回答
// - timeout / aborted：未得到选择
// ============================================================================
import type {
  UserQuestion,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../../shared/contract';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { AppWindow, ipcHost } from '../../platform';
import { INTERACTION_TIMEOUTS } from '../../../shared/constants';
import {
  canOfferVoiceQuestion,
  cancelVoiceQuestion,
  offerVoiceQuestion,
} from '../../services/voice/voiceQuestionBridge';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('UserQuestionPrompt');

export type PromptUserStatus = 'answered' | 'declined' | 'no-renderer' | 'timeout' | 'aborted';

export interface PromptUserResult {
  status: PromptUserStatus;
  response?: UserQuestionResponse;
}

export interface PromptUserOptions {
  sessionId?: string;
  abortSignal?: AbortSignal;
  /** 覆盖默认超时（INTERACTION_TIMEOUTS.USER_QUESTION）。 */
  timeoutMs?: number;
  /** 桌面通知（best-effort）。 */
  notify?: { title: string; body: string };
}

const pending = new Map<
  string,
  { resolve: (r: UserQuestionResponse) => void; timeout: ReturnType<typeof setTimeout> }
>();

let handlerRegistered = false;

function settleUserQuestionResponse(response: UserQuestionResponse): void {
  const p = pending.get(response.requestId);
  if (!p) return;
  clearTimeout(p.timeout);
  pending.delete(response.requestId);
  cancelVoiceQuestion(response.requestId);
  p.resolve(response);
}

function ensureResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  ipcHost.handle(
    IPC_CHANNELS.USER_QUESTION_RESPONSE,
    async (_event, response: UserQuestionResponse) => {
      settleUserQuestionResponse(response);
    },
  );
}

/**
 * 把一组问题推到会话区，阻塞等待用户选择。
 * 不做参数校验 / 权限（由调用方负责），只负责 round-trip。
 */
export async function promptUserInChat(
  questions: UserQuestion[],
  opts: PromptUserOptions = {},
): Promise<PromptUserResult> {
  if (opts.abortSignal?.aborted) return { status: 'aborted' };

  ensureResponseHandler();

  const request: UserQuestionRequest = {
    id: `q-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
    sessionId: opts.sessionId,
    questions,
    timestamp: Date.now(),
  };

  const mainWindow = AppWindow.getAllWindows()[0];
  const hasInteractiveRenderer = Boolean(mainWindow && AppWindow.hasInteractiveRenderer());
  const hasVoiceQuestionRoute = canOfferVoiceQuestion(opts.sessionId);
  if (!hasInteractiveRenderer && !hasVoiceQuestionRoute) {
    return { status: 'no-renderer' };
  }

  const timeoutMs = opts.timeoutMs ?? INTERACTION_TIMEOUTS.USER_QUESTION;
  const responsePromise = new Promise<UserQuestionResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(request.id);
      cancelVoiceQuestion(request.id);
      reject(new Error('timeout'));
    }, timeoutMs);
    pending.set(request.id, { resolve, timeout });

    if (opts.abortSignal) {
      opts.abortSignal.addEventListener(
        'abort',
        () => {
          const p = pending.get(request.id);
          if (p) {
            clearTimeout(p.timeout);
            pending.delete(request.id);
            cancelVoiceQuestion(request.id);
            reject(new Error('aborted'));
          }
        },
        { once: true },
      );
    }
  });

  try {
    if (hasInteractiveRenderer) {
      mainWindow?.webContents.send(IPC_CHANNELS.USER_QUESTION_ASK, request);
    }
    const voiceOffered = offerVoiceQuestion(request, settleUserQuestionResponse);
    if (!hasInteractiveRenderer && !voiceOffered) {
      const p = pending.get(request.id);
      if (p) {
        clearTimeout(p.timeout);
        pending.delete(request.id);
      }
      logger.warn('user question route disappeared before delivery', {
        requestId: request.id,
        sessionId: request.sessionId,
      });
      return { status: 'no-renderer' };
    }
  } catch (error) {
    const p = pending.get(request.id);
    if (p) {
      clearTimeout(p.timeout);
      pending.delete(request.id);
      cancelVoiceQuestion(request.id);
    }
    throw error;
  }

  try {
    if (opts.notify) {
      try {
        const { notificationService } = await import('../../services/infra/notificationService');
        notificationService.notifyNeedsInput({
          sessionId: opts.sessionId || '',
          title: opts.notify.title,
          body: opts.notify.body,
        });
      } catch {
        /* ignore */
      }
    }

    const response = await responsePromise;
    return { status: response.declined === true ? 'declined' : 'answered', response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    return { status: msg === 'aborted' ? 'aborted' : 'timeout' };
  }
}
