import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/styles/global.css';
import { TurnFeedback } from '../../../src/renderer/components/features/chat/TurnFeedback';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);
document.documentElement.classList.add(theme);
document.body.className = theme === 'light'
  ? 'min-h-screen bg-neutral-100 text-neutral-900'
  : 'min-h-screen bg-zinc-950 text-zinc-100';

useAppStore.setState({ language: 'zh' });
useSessionStore.setState({ currentSessionId: 'visual-feedback-session' });

Reflect.set(window, 'codeAgentAPI', {
  invoke: async (channel: string) => (
    channel === IPC_CHANNELS.TELEMETRY_GET_SESSION_FEEDBACK ? [] : { success: true }
  ),
});

const root = document.getElementById('root');
if (!root) throw new Error('Visual harness root not found');

createRoot(root).render(
  <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-16 py-20">
    <section className="w-full rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-5 text-sm leading-6 text-neutral-700 dark:text-zinc-300">
        我已经完成了文件整理，并保留了原目录结构和命名。
      </p>
      <TurnFeedback messageId="visual-message-1" content="我已经完成了文件整理，并保留了原目录结构和命名。" />
    </section>
  </main>,
);
