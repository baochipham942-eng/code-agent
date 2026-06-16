import { IPC_CHANNELS, type IpcInvokeHandlers, type IpcEventHandlers } from '@shared/ipc';
import type { SpeechTranscribeOptions, SpeechTranscribeResult } from '@shared/contract';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import { createInflightDedupe } from '../utils/inflightDedupe';

type AgentEventEnvelope = Parameters<IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT]>[0];

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

function getStringField(data: unknown, field: string): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(data: unknown, field: string): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : undefined;
}

function getAgentEventSeq(event: AgentEventEnvelope): number | undefined {
  return typeof event.seq === 'number'
    ? event.seq
    : getNumberField(event.data, 'seq');
}

function getAgentEventSessionKey(event: AgentEventEnvelope): string {
  return event.sessionId || getStringField(event.data, 'sessionId') || '__global__';
}

function createSequencedAgentEventDispatcher(
  callback: IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT],
): IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT] {
  const lastSeqBySession = new Map<string, number>();

  return (event) => {
    const seq = getAgentEventSeq(event);
    if (seq !== undefined) {
      const sessionKey = getAgentEventSessionKey(event);
      const lastSeq = lastSeqBySession.get(sessionKey);
      if (lastSeq !== undefined && seq <= lastSeq) {
        recordStreamingPerformanceCounter('stream.ipc.duplicate_dropped');
        return;
      }
      lastSeqBySession.set(sessionKey, seq);
    }

    callback(event);
  };
}

export function on<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): (() => void) | undefined {
  const api = commandApi();
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

async function invokeDomainRaw<T = unknown>(
  domain: string,
  action: string,
  payload?: unknown
): Promise<T> {
  const response = await domainApi()?.invoke<T>(domain, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `${domain}:${action} failed`);
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
