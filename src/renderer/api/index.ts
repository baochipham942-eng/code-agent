// ============================================================================
// API Transport - 自动选择通信方式
// ============================================================================
//
// 在 renderer 入口处调用 initTransport()：
// - Native bridge：使用 preload 注入的 window.codeAgentAPI
// - HTTP bridge：注入 HTTP polyfill 到 window.codeAgentAPI / window.codeAgentDomainAPI
//
// 旧 window.electronAPI / window.domainAPI 会作为兼容别名保留。
//
// ============================================================================

/// <reference path="../types/electron.d.ts" />

import { hasNativeBridge, getApiBaseUrl } from './transport';
import { createHttpCodeAgentAPI, createHttpDomainAPI } from './httpTransport';

/**
 * 初始化通信层。
 * 必须在 React 渲染之前调用。
 */
export function initTransport(): void {
  if (hasNativeBridge()) {
    window.codeAgentAPI = window.codeAgentAPI || window.electronAPI;
    window.codeAgentDomainAPI = window.codeAgentDomainAPI || window.domainAPI;
    console.log('[Transport] Native bridge mode');
    return;
  }

  // HTTP 模式：注入 polyfill
  const apiUrl = getApiBaseUrl();
  console.log(`[Transport] HTTP mode - API: ${apiUrl}`);

  window.__CODE_AGENT_HTTP_BRIDGE__ = true;

  // 注入中性 Code Agent API polyfill
  if (!window.codeAgentAPI) {
    window.codeAgentAPI = createHttpCodeAgentAPI(apiUrl);
  }

  if (!window.codeAgentDomainAPI) {
    window.codeAgentDomainAPI = createHttpDomainAPI(apiUrl);
  }

  // 兼容旧 renderer 模块，后续迁移组件时再逐步删除。
  window.electronAPI = window.electronAPI || window.codeAgentAPI;
  window.domainAPI = window.domainAPI || window.codeAgentDomainAPI;
}

/**
 * 获取当前运行模式
 */
export function getTransportMode(): 'native' | 'http' {
  return hasNativeBridge() ? 'native' : 'http';
}

/**
 * 更新 HTTP API 地址（运行时切换）
 */
export function setApiUrl(url: string): void {
  localStorage.setItem('code-agent-api-url', url);
  // 重新注入 polyfill
  window.__CODE_AGENT_HTTP_BRIDGE__ = true;
  window.codeAgentAPI = createHttpCodeAgentAPI(url);
  window.codeAgentDomainAPI = createHttpDomainAPI(url);
  window.electronAPI = window.codeAgentAPI;
  window.domainAPI = window.codeAgentDomainAPI;
}
