import type { IpcInvokeHandlers, IpcEventHandlers } from '@shared/ipc';

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

export function on<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): (() => void) | undefined {
  return commandApi()?.on(channel, callback);
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
