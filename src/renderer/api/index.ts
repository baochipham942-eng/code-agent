// ============================================================================
// API Transport - 自动选择通信方式
// ============================================================================
//
// 在 renderer 入口处调用 initTransport()：
// - Electron 环境：无操作（preload 已注入 window.electronAPI）
// - 浏览器环境：注入 HTTP polyfill 到 window.electronAPI / window.domainAPI
//
// 这样现有组件代码中的 window.electronAPI?.invoke(...) 无需修改。
//
// ============================================================================

/// <reference path="../types/electron.d.ts" />

import { isElectron, getApiBaseUrl } from './transport';
import { createHttpElectronAPI, createHttpDomainAPI } from './httpTransport';

/**
 * 初始化通信层。
 * 必须在 React 渲染之前调用。
 */
export function initTransport(): void {
  if (isElectron()) {
    // Electron 模式：preload 已经注入了 window.electronAPI 和 window.domainAPI
    console.log('[Transport] Electron mode - using IPC');
    return;
  }

  // HTTP 模式：注入 polyfill
  const apiUrl = getApiBaseUrl();
  console.log(`[Transport] HTTP mode - API: ${apiUrl}`);

  // 注入 electronAPI polyfill
  if (!window.electronAPI) {
    window.electronAPI = createHttpElectronAPI(apiUrl);
  }

  // 注入 domainAPI polyfill
  if (!window.domainAPI) {
    window.domainAPI = createHttpDomainAPI(apiUrl);
  }
}

/**
 * 获取当前运行模式
 */
export function getTransportMode(): 'electron' | 'http' {
  return isElectron() ? 'electron' : 'http';
}

/**
 * 更新 HTTP API 地址（运行时切换）
 */
export function setApiUrl(url: string): void {
  localStorage.setItem('code-agent-api-url', url);
  // 重新注入 polyfill
  window.electronAPI = createHttpElectronAPI(url);
  window.domainAPI = createHttpDomainAPI(url);
}
