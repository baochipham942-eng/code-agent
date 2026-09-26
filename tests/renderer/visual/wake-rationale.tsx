import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/styles/global.css';
import { WakeRationaleNote } from '../../../src/renderer/components/features/chat/WakeRationaleNote';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);
document.documentElement.classList.add(theme);
document.body.className = theme === 'light'
  ? 'min-h-screen bg-neutral-100 text-neutral-900'
  : 'min-h-screen bg-zinc-950 text-zinc-100';

useAppStore.setState({ language: 'zh' });

const SuggestCard: React.FC<{ missing?: boolean }> = ({ missing }) => (
  <section
    data-testid="wake-suggest-card"
    className="w-full rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
  >
    <p className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">主动巡检 · suggest</p>
    <p className="text-sm leading-6 text-neutral-700 dark:text-zinc-300">
      建议把周报改成自动生成，避免连续两周空白。
    </p>
    <WakeRationaleNote
      fields={missing
        ? { missing: true }
        : { rationale: '履历里的周报已经连续两周没更新，值得现在提醒。', evidence: 'history.md · 周报.md', missing: false }}
    />
  </section>
);

const root = document.getElementById('root');
if (!root) throw Error('Visual harness root not found');

const missing = new URLSearchParams(window.location.search).get('missing') === '1';

createRoot(root).render(
  <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-16 py-20">
    <SuggestCard missing={missing} />
  </main>,
);
