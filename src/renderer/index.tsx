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
