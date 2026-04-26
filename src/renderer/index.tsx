import { initTransport } from "./api";

// Must run before React renders — injects HTTP polyfill in browser mode
initTransport();

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { useAppStore } from './stores/appStore';
import { IPC_DOMAINS } from '@shared/ipc';
import { invokeDomain } from './services/ipcService';

// 全局调试入口：DevTools Console 执行 __openLivePreview('http://localhost:5175/')
// Tauri dev 跑的是 build:web 产物（production bundle），import.meta.env.DEV=false
// 无条件挂载，等 D6 接入 ChatInput Ability Menu 后移除
declare global {
  interface Window {
    __openLivePreview?: (url: string) => Promise<void>;
    // V2-A 调试入口：Console 调 __startDevServer('/path/to/project')
    // 自动跑探测 → 启动 → 等 ready → 把 URL 喂给 LivePreviewFrame
    __startDevServer?: (projectPath: string) => Promise<void>;
    __stopDevServer?: (sessionId: string) => Promise<void>;
    /** D3: 弹出 DevServerLauncher 模态（带 UI 选目录） */
    __openDevServerLauncher?: () => void;
  }
}
window.__openLivePreview = async (url: string) => {
  try {
    const result = await invokeDomain<{ url: string }>(
      IPC_DOMAINS.LIVE_PREVIEW,
      'validateDevServerUrl',
      { url },
    );
    useAppStore.getState().openLivePreview(result.url);
  } catch (err) {
    console.error('[LivePreview] URL rejected', err);
  }
};

window.__startDevServer = async (projectPath: string) => {
  try {
    const detection = await invokeDomain<{
      framework: string;
      packageManager: string;
      supported: boolean;
      reason?: string;
    }>(IPC_DOMAINS.LIVE_PREVIEW, 'detectFramework', { path: projectPath });
    console.log('[LivePreview] detect:', detection);
    if (!detection.supported) {
      console.error('[LivePreview] 不支持:', detection.reason);
      return;
    }
    const session = await invokeDomain<{ sessionId: string; status: string }>(
      IPC_DOMAINS.LIVE_PREVIEW,
      'startDevServer',
      { path: projectPath },
    );
    console.log('[LivePreview] starting session:', session.sessionId);
    const ready = await invokeDomain<{ url: string }>(
      IPC_DOMAINS.LIVE_PREVIEW,
      'waitDevServerReady',
      { sessionId: session.sessionId },
    );
    console.log('[LivePreview] ready URL:', ready.url, '(session', session.sessionId, ')');
    useAppStore.getState().openLivePreview(ready.url);
  } catch (err) {
    console.error('[LivePreview] startDevServer failed', err);
  }
};

window.__stopDevServer = async (sessionId: string) => {
  try {
    await invokeDomain(IPC_DOMAINS.LIVE_PREVIEW, 'stopDevServer', { sessionId });
    console.log('[LivePreview] stopped', sessionId);
  } catch (err) {
    console.error('[LivePreview] stopDevServer failed', err);
  }
};

window.__openDevServerLauncher = () => {
  useAppStore.getState().openDevServerLauncher();
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
