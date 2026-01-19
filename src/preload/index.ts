// ============================================================================
// Preload Script - Bridge between main and renderer processes
// ============================================================================

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ElectronAPI, IPCRequest, IPCResponse, IPCDomain } from '../shared/ipc';

// Type-safe IPC wrapper
const electronAPI: ElectronAPI = {
  invoke: (channel, ...args) => {
    return ipcRenderer.invoke(channel, ...args) as any;
  },

  on: (channel, callback) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: any[]) => {
      (callback as (...args: any[]) => void)(...args);
    };

    ipcRenderer.on(channel, subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback as any);
  },

  // Electron 33+ 获取文件路径的方法
  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file);
  },

  // PDF 文本提取 - 在主进程处理避免 CSP 问题
  extractPdfText: (filePath: string) => {
    return ipcRenderer.invoke('extract-pdf-text', filePath);
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
   * @param domain 领域名称 (session, generation, auth, etc.)
   * @param action 操作名称 (list, create, delete, etc.)
   * @param payload 可选的请求参数
   * @returns IPCResponse
   */
  invoke: async <T = unknown>(
    domain: IPCDomain,
    action: string,
    payload?: unknown
  ): Promise<IPCResponse<T>> => {
    const request: IPCRequest = {
      action,
      payload,
      requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };
    return ipcRenderer.invoke(domain, request) as Promise<IPCResponse<T>>;
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('domainAPI', domainAPI);
