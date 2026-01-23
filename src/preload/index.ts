// ============================================================================
// Preload Script - Bridge between main and renderer processes
// ============================================================================

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ElectronAPI, IPCRequest, IPCResponse, IPCDomain } from '../shared/ipc';

// Type-safe IPC wrapper
const electronAPI: ElectronAPI = {
  invoke: <K extends keyof import('../shared/ipc').IpcInvokeHandlers>(
    channel: K,
    ...args: Parameters<import('../shared/ipc').IpcInvokeHandlers[K]>
  ) => {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<import('../shared/ipc').IpcInvokeHandlers[K]>;
  },

  on: <K extends keyof import('../shared/ipc').IpcEventHandlers>(
    channel: K,
    callback: import('../shared/ipc').IpcEventHandlers[K]
  ) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      (callback as (...cbArgs: unknown[]) => void)(...args);
    };

    ipcRenderer.on(channel, subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  off: <K extends keyof import('../shared/ipc').IpcEventHandlers>(
    channel: K,
    callback: import('../shared/ipc').IpcEventHandlers[K]
  ) => {
    ipcRenderer.removeListener(channel, callback as (...args: unknown[]) => void);
  },

  // Electron 33+ 获取文件路径的方法
  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file);
  },

  // PDF 文本提取 - 在主进程处理避免 CSP 问题
  extractPdfText: (filePath: string) => {
    return ipcRenderer.invoke('extract-pdf-text', filePath);
  },

  // Excel 文本提取 - 使用 xlsx 库
  extractExcelText: (filePath: string): Promise<{ text: string; sheetCount: number; rowCount: number }> => {
    return ipcRenderer.invoke('extract-excel-text', filePath);
  },

  // 语音转写 - 使用 Groq Whisper API
  transcribeSpeech: (audioData: string, mimeType: string) => {
    return ipcRenderer.invoke('speech:transcribe', { audioData, mimeType });
  },
};

// ============================================================================
// New Domain-based API (TASK-04)
// ============================================================================

/**
 * 新版 Domain API - 统一的请求/响应格式
 * 使用方式: domainAPI.invoke('session', 'list') 或 domainAPI.invoke('session', 'create', { title: 'xxx' })
 */
const domainAPI = {
  /**
   * 调用领域通道
   * @param domain 领域名称 (session, generation, auth, etc.) - 可带或不带 'domain:' 前缀
   * @param action 操作名称 (list, create, delete, etc.)
   * @param payload 可选的请求参数
   * @returns IPCResponse
   */
  invoke: async <T = unknown>(
    domain: IPCDomain | string,
    action: string,
    payload?: unknown
  ): Promise<IPCResponse<T>> => {
    // Normalize domain: add 'domain:' prefix if not present
    // This fixes the "No handler registered for 'workspace'" error
    // when frontend calls domainAPI.invoke('workspace', ...) but backend expects 'domain:workspace'
    const normalizedDomain = domain.startsWith('domain:') ? domain : `domain:${domain}`;

    const request: IPCRequest = {
      action,
      payload,
      requestId: `req_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
    };
    return ipcRenderer.invoke(normalizedDomain, request) as Promise<IPCResponse<T>>;
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('domainAPI', domainAPI);
