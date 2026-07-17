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

export type PromptUserStatus = 'answered' | 'no-renderer' | 'timeout' | 'aborted';

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

function ensureResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  ipcHost.handle(
    IPC_CHANNELS.USER_QUESTION_RESPONSE,
    async (_event, response: UserQuestionResponse) => {
      const p = pending.get(response.requestId);
      if (p) {
        clearTimeout(p.timeout);
        pending.delete(response.requestId);
        p.resolve(response);
      }
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
  if (!mainWindow || !AppWindow.hasInteractiveRenderer()) {
    return { status: 'no-renderer' };
  }

  mainWindow.webContents.send(IPC_CHANNELS.USER_QUESTION_ASK, request);

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

  const timeoutMs = opts.timeoutMs ?? INTERACTION_TIMEOUTS.USER_QUESTION;

  try {
    const response = await new Promise<UserQuestionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(request.id);
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
              reject(new Error('aborted'));
            }
          },
          { once: true },
        );
      }
    });
    return { status: 'answered', response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    return { status: msg === 'aborted' ? 'aborted' : 'timeout' };
  }
}
