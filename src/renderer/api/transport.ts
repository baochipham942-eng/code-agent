// ============================================================================
// Transport API - 统一通信接口
// ============================================================================
//
// 抽象层，使 renderer 可以在 Electron IPC 和 HTTP API 两种模式下运行。
// Electron 模式：直接调用 window.electronAPI / window.domainAPI
// HTTP 模式：通过 fetch + EventSource 调用 HTTP API
//
// ============================================================================

/**
 * 检测是否在 Electron 环境中运行
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * 获取 HTTP API 基地址
 * 优先级：URL 参数 > localStorage > 默认值
 */
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:8180';

  // 从 URL 参数读取
  const urlParams = new URLSearchParams(window.location.search);
  const urlApi = urlParams.get('api');
  if (urlApi) return urlApi;

  // 从 localStorage 读取
  const stored = localStorage.getItem('code-agent-api-url');
  if (stored) return stored;

  // 默认：同源（serve.ts 提供静态文件时，API 和页面同源）
  return window.location.origin;
}
