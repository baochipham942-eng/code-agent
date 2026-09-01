import { IPC_CHANNELS, type IpcEventHandlers, type IpcInvokeHandlers } from '@shared/ipc';
import type { SpeechTranscribeOptions, SpeechTranscribeResult } from '@shared/contract';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import { createInflightDedupe } from '../utils/inflightDedupe';

function commandApi() {
  return window.codeAgentAPI || window.electronAPI;
}

function domainApi() {
  return window.codeAgentDomainAPI || window.domainAPI;
}

export function invoke<K extends keyof IpcInvokeHandlers>(
  channel: K,
  ...args: Parameters<IpcInvokeHandlers[K]>
): ReturnType<IpcInvokeHandlers[K]> {
  return commandApi()?.invoke(channel, ...args) as ReturnType<IpcInvokeHandlers[K]>;
}

/**
 * 逃生入口：调用尚未进 IpcInvokeHandlers 联合类型的合法通道（如 skill:* / command:*）。
 * channel/args 显式 string/unknown，把"通道注册表未覆盖"这一事实收口到一个具名边界，
 * 避免在各 store/组件里散落 `as any`。通道补进注册表后即可改回类型安全的 invoke。
 */
export function unsafeInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> | undefined {
  const raw = commandApi()?.invoke as
    | ((channel: string, ...args: unknown[]) => Promise<T>)
    | undefined;
  return raw?.(channel, ...args);
}

type SnapshotRequiredHandler = IpcEventHandlers[typeof IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED];

const snapshotRequiredHandlers = new Set<SnapshotRequiredHandler>();
const lastSnapshotRequestBySession = new Map<string, string>();

function notifySnapshotRequired(event: Parameters<SnapshotRequiredHandler>[0]): void {
  const key = `${event.streamEpoch}:${event.watermark}:${event.reason}`;
  const sessionKey = event.sessionId ?? '__global__';
  if (lastSnapshotRequestBySession.get(sessionKey) === key) return;
  lastSnapshotRequestBySession.set(sessionKey, key);
  if (lastSnapshotRequestBySession.size > 256) {
    const oldest = lastSnapshotRequestBySession.keys().next().value;
    if (oldest !== undefined) lastSnapshotRequestBySession.delete(oldest);
  }
  snapshotRequiredHandlers.forEach((handler) => {
    try {
      void Promise.resolve(handler(event)).catch((error) => {
        console.error('[ipcService] Failed to refresh agent stream snapshot', error);
      });
    } catch (error) {
      console.error('[ipcService] Failed to request agent stream snapshot', error);
    }
  });
}

function createSequencedAgentEventDispatcher(
  callback: IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT],
): IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT] {
  let activeStreamEpoch: string | undefined;
  const lastSeqBySession = new Map<string, number>();

  return (event) => {
    const { streamEpoch, sessionId, seq } = event;
    if (
      typeof streamEpoch !== 'string'
      || streamEpoch.length === 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
      || !Number.isInteger(seq)
      || seq <= 0
    ) {
      return;
    }
    if (activeStreamEpoch !== undefined && streamEpoch !== activeStreamEpoch) {
      lastSeqBySession.clear();
      notifySnapshotRequired({
        transport: streamEpoch.startsWith('http:') ? 'http-sse' : 'native-ipc',
        streamEpoch,
        sessionId,
        watermark: seq,
        reason: 'epoch_changed',
      });
    }
    activeStreamEpoch = streamEpoch;

    const lastSeq = lastSeqBySession.get(sessionId);
    if (lastSeq !== undefined && seq <= lastSeq) {
      recordStreamingPerformanceCounter('stream.ipc.duplicate_dropped');
      return;
    }
    if ((lastSeq === undefined && seq > 1) || (lastSeq !== undefined && seq > lastSeq + 1)) {
      notifySnapshotRequired({
        transport: streamEpoch.startsWith('http:') ? 'http-sse' : 'native-ipc',
        streamEpoch,
        sessionId,
        watermark: seq,
        reason: 'sequence_gap',
      });
    }
    lastSeqBySession.set(sessionId, seq);

    callback(event);
  };
}

export function on<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): (() => void) | undefined {
  const api = commandApi();
  if (channel === IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED) {
    const snapshotCallback = callback as SnapshotRequiredHandler;
    snapshotRequiredHandlers.add(snapshotCallback);
    const unsubscribeBridge = api?.on(
      IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED,
      snapshotCallback,
    );
    return () => {
      snapshotRequiredHandlers.delete(snapshotCallback);
      unsubscribeBridge?.();
    };
  }
  if (!api) return undefined;

  if (channel !== IPC_CHANNELS.AGENT_EVENT) {
    const unsubscribe = api.on(channel, callback);
    return unsubscribe;
  }

  const agentEventCallback = callback as IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT];
  const sequencedCallback = createSequencedAgentEventDispatcher(agentEventCallback);
  const unsubscribe = api.on(IPC_CHANNELS.AGENT_EVENT, sequencedCallback);
  const batchCallback: IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT_BATCH] = (events) => {
    recordStreamingPerformanceCounter('stream.ipc.batch_received');
    recordStreamingPerformanceCounter('stream.ipc.batch_events', events.length);
    events.forEach((event) => sequencedCallback(event));
  };
  const unsubscribeBatch = api.on(IPC_CHANNELS.AGENT_EVENT_BATCH, batchCallback);

  return () => {
    unsubscribe?.();
    unsubscribeBatch?.();
  };
}

export function off<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): void {
  commandApi()?.off(channel, callback);
}

export function getPathForFile(file: File): string | Promise<string> | undefined {
  return commandApi()?.getPathForFile(file);
}

export function extractPdfText(filePath: string): Promise<{ text: string; pageCount: number }> | undefined {
  return commandApi()?.extractPdfText(filePath);
}

export function extractExcelText(filePath: string): Promise<{ text: string; sheetCount: number; rowCount: number }> | undefined {
  return commandApi()?.extractExcelText(filePath);
}

export function extractExcelJson(filePath: string) {
  return commandApi()?.extractExcelJson(filePath);
}

export function extractDocxHtml(filePath: string) {
  return commandApi()?.extractDocxHtml(filePath);
}

export function transcribeSpeech(
  audioData: string,
  mimeType: string,
  options?: SpeechTranscribeOptions,
): Promise<SpeechTranscribeResult> | undefined {
  const api = commandApi();
  return options === undefined
    ? api?.transcribeSpeech(audioData, mimeType)
    : api?.transcribeSpeech(audioData, mimeType, options);
}

export function isAvailable(): boolean {
  return !!commandApi();
}

/**
 * 域 IPC 失败时抛出的错误，**保留宿主给的 error.code**。
 *
 * 宿主侧对已知错误类（ConversationBranchError / SessionForkError 等）会把 code 原样放进
 * 信封（见 session.ipc.ts 的 catch）。此前这里只取 message 重新包 Error，code 在这一跳被丢掉，
 * 于是渲染层想区分「预期状态」和「真故障」只能去抠 message 字符串——按名字枚举，改个文案就失效。
 * 现在 code 跟着错误走，调用方按 code 判定即可。
 */
export class DomainInvokeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DomainInvokeError';
  }
}

async function invokeDomainRaw<T = unknown>(
  domain: string,
  action: string,
  payload?: unknown
): Promise<T> {
  const response = await domainApi()?.invoke<T>(domain, action, payload);
  if (!response?.success) {
    throw new DomainInvokeError(
      response?.error?.code || 'INTERNAL_ERROR',
      response?.error?.message || `${domain}:${action} failed`,
    );
  }
  return response.data as T;
}

/**
 * 只读类 action（get / list 前缀）才参与在途去重——这些幂等读在挂载期被多个
 * 组件并发触发（如 settings get 13 次），共享同一 Promise 安全且显著减少请求。
 * 写操作（set / create / update / delete 等）返回 null，绝不去重。
 */
function dedupeKeyForDomainInvoke(domain: string, action: string, payload?: unknown): string | null {
  if (!/^(get|list)/.test(action)) {
    return null;
  }
  return `${domain}:${action}:${payload === undefined ? '' : JSON.stringify(payload)}`;
}

const dedupedInvokeDomain = createInflightDedupe(invokeDomainRaw, dedupeKeyForDomainInvoke);

export function invokeDomain<T = unknown>(
  domain: string,
  action: string,
  payload?: unknown
): Promise<T> {
  return dedupedInvokeDomain(domain, action, payload) as Promise<T>;
}

export const ipcService = {
  invoke,
  unsafeInvoke,
  invokeDomain,
  on,
  off,
  getPathForFile,
  extractPdfText,
  extractExcelText,
  extractExcelJson,
  extractDocxHtml,
  transcribeSpeech,
  isAvailable,
};

export default ipcService;
