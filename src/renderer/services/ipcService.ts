import type { IpcInvokeHandlers, IpcEventHandlers } from '@shared/ipc';

export function invoke<K extends keyof IpcInvokeHandlers>(
  channel: K,
  ...args: Parameters<IpcInvokeHandlers[K]>
): ReturnType<IpcInvokeHandlers[K]> {
  return window.electronAPI?.invoke(channel, ...args) as ReturnType<IpcInvokeHandlers[K]>;
}

export function on<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): (() => void) | undefined {
  return window.electronAPI?.on(channel, callback);
}

export function off<K extends keyof IpcEventHandlers>(
  channel: K,
  callback: IpcEventHandlers[K]
): void {
  window.electronAPI?.off(channel, callback);
}

export function getPathForFile(file: File): string | Promise<string> | undefined {
  return window.electronAPI?.getPathForFile(file);
}

export function extractPdfText(filePath: string): Promise<{ text: string; pageCount: number }> | undefined {
  return window.electronAPI?.extractPdfText(filePath);
}

export function extractExcelText(filePath: string): Promise<{ text: string; sheetCount: number; rowCount: number }> | undefined {
  return window.electronAPI?.extractExcelText(filePath);
}

export function transcribeSpeech(audioData: string, mimeType: string): Promise<{
  success: boolean;
  text?: string;
  error?: string;
  hallucination?: boolean;
}> | undefined {
  return window.electronAPI?.transcribeSpeech(audioData, mimeType);
}

export function isAvailable(): boolean {
  return !!window.electronAPI;
}

export const ipcService = {
  invoke,
  on,
  off,
  getPathForFile,
  extractPdfText,
  extractExcelText,
  transcribeSpeech,
  isAvailable,
};

export default ipcService;
