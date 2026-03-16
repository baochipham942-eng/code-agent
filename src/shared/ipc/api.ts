// ============================================================================
// IPC API - Preload API 类型定义
// ============================================================================

import type { IpcInvokeHandlers } from './handlers';
import type { IpcEventHandlers } from './handlers';
import type { IPCResponse } from './domains';

// ----------------------------------------------------------------------------
// Preload API exposed to renderer
// ----------------------------------------------------------------------------

export interface ElectronAPI {
  // Invoke methods (async request/response)
  invoke: <K extends keyof IpcInvokeHandlers>(
    channel: K,
    ...args: Parameters<IpcInvokeHandlers[K]>
  ) => ReturnType<IpcInvokeHandlers[K]>;

  // Event listeners
  on: <K extends keyof IpcEventHandlers>(
    channel: K,
    callback: IpcEventHandlers[K]
  ) => () => void;

  // Remove event listener
  off: <K extends keyof IpcEventHandlers>(
    channel: K,
    callback: IpcEventHandlers[K]
  ) => void;

  // Electron 33+ 获取文件的本地路径
  getPathForFile: (file: File) => string | Promise<string>;

  // PDF 文本提取（在主进程处理）
  extractPdfText: (filePath: string) => Promise<{ text: string; pageCount: number }>;

  // Excel 文本提取（使用 xlsx 库）
  extractExcelText: (filePath: string) => Promise<{ text: string; sheetCount: number; rowCount: number }>;

  // 语音转写（使用 Groq Whisper API）
  transcribeSpeech: (audioData: string, mimeType: string) => Promise<{
    success: boolean;
    text?: string;
    error?: string;
    hallucination?: boolean;
  }>;
}

/**
 * Domain API exposed to renderer (new unified API)
 */
export interface DomainAPI {
  invoke: <T = unknown>(
    domain: string,
    action: string,
    payload?: unknown
  ) => Promise<IPCResponse<T>>;
}

// Note: Window.electronAPI and Window.domainAPI are declared in src/renderer/types/electron.d.ts
