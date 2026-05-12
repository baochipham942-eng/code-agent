import { IPC_CHANNELS, type IpcInvokeHandlers, type IpcEventHandlers } from '@shared/ipc';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';

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

export function transcribeSpeech(audioData: string, mimeType: string): Promise<{
  success: boolean;
  text?: string;
  error?: string;
  hallucination?: boolean;
}> | undefined {
  return commandApi()?.transcribeSpeech(audioData, mimeType);
}

export function isAvailable(): boolean {
  return !!commandApi();
}

export async function invokeDomain<T = unknown>(
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

export const ipcService = {
  invoke,
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
