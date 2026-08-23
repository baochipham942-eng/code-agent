import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/styles/global.css';
import { ShareLinkPanel } from '../../../src/renderer/components/features/chat/MessageBubble/ShareLinkPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);
document.documentElement.classList.add(theme);
document.body.className = 'min-h-screen bg-zinc-950 text-zinc-100';
useAppStore.setState({ language: 'zh' });

Reflect.set(window, 'domainAPI', {
  invoke: async (_domain: string, action: string) => {
    if (action !== 'getShareLink') {
      return { success: false, error: { code: 'UNSUPPORTED', message: `Unexpected visual harness action: ${action}` } };
    }
    return {
      success: true,
      data: {
        share: {
          token: 'm7jK2pQ4xN8bV5cL1sT6wA',
          url: 'https://share.llmxy.xyz/d/m7jK2pQ4xN8bV5cL1sT6wA',
          expiresAt: 1_788_022_800_000,
          createdAt: 1_787_503_200_000,
          ttlSeconds: 604_800,
          pushedVersion: 2,
          pushedHash: 'visual-hash-v2',
          lastError: 'Previous automatic push failed',
        },
        stale: true,
        latestPublishedVersion: 3,
        tokenConfigured: true,
      },
    };
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Visual harness root not found');

createRoot(root).render(
  <ShareLinkPanel
    isOpen
    filePath="/workspace/客户交付方案.html"
    title="客户交付方案 · 发布版 v3"
    onClose={() => undefined}
  />,
);
