import React, { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { DiffView } from '../../src/renderer/components/DiffView';
import { MessageContent } from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  getStreamingPerformanceSnapshot,
  resetStreamingPerformanceMetrics,
} from '../../src/renderer/utils/streamingPerformanceMetrics';

interface ChatRenderBrowserResult {
  mountMs: number;
  longTasks: Array<{ name: string; startTime: number; duration: number }>;
  rendered: {
    codeBlocks: number;
    codeLinesPerBlock: number;
    streamingChars: number;
    diffLines: number;
    diffRows: number;
  };
  metrics: ReturnType<typeof getStreamingPerformanceSnapshot>;
}

declare global {
  interface Window {
    __CHAT_RENDER_BROWSER_STARTED_AT__?: number;
    __CHAT_RENDER_BROWSER_LONG_TASKS__?: ChatRenderBrowserResult['longTasks'];
    __CHAT_RENDER_BROWSER_RESULT__?: ChatRenderBrowserResult;
  }
}

const CODE_BLOCKS = 10;
const CODE_LINES_PER_BLOCK = 500;
const DIFF_LINES = 5_000;

function makeCodeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `export const ${prefix}_${n} = { id: ${n}, label: "${prefix}-${n}", enabled: ${n % 2 === 0} };`;
  }).join('\n');
}

function makeMarkdownWithCodeBlocks(blockCount: number, linesPerBlock: number): string {
  return Array.from({ length: blockCount }, (_, index) => [
    `### Browser code block ${index + 1}`,
    '',
    '```ts',
    makeCodeLines(`browser_block_${index + 1}`, linesPerBlock),
    '```',
  ].join('\n')).join('\n\n');
}

function makeTextLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `${prefix} line ${n} value_${n}`;
  }).join('\n');
}

function installLongTaskObserver(): void {
  window.__CHAT_RENDER_BROWSER_LONG_TASKS__ = [];

  if (!('PerformanceObserver' in window)) return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__CHAT_RENDER_BROWSER_LONG_TASKS__?.push({
          name: entry.name,
          startTime: Math.round(entry.startTime * 1000) / 1000,
          duration: Math.round(entry.duration * 1000) / 1000,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long task observation is best-effort browser evidence.
  }
}

function BrowserHarness(): React.ReactElement {
  const markdown = useMemo(
    () => makeMarkdownWithCodeBlocks(CODE_BLOCKS, CODE_LINES_PER_BLOCK),
    [],
  );
  const streamingText = useMemo(
    () => 'Streaming output with markdown-free text and file-ish paths. '.repeat(400),
    [],
  );
  const oldText = useMemo(() => makeTextLines('old-browser', DIFF_LINES), []);
  const newText = useMemo(() => makeTextLines('new-browser', DIFF_LINES), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const mountMs = performance.now() - (window.__CHAT_RENDER_BROWSER_STARTED_AT__ ?? performance.now());
          const diffRows = document.querySelectorAll('[data-chat-browser-diff] tbody tr').length;
          window.__CHAT_RENDER_BROWSER_RESULT__ = {
            mountMs: Math.round(mountMs * 1000) / 1000,
            longTasks: window.__CHAT_RENDER_BROWSER_LONG_TASKS__ ?? [],
            rendered: {
              codeBlocks: CODE_BLOCKS,
              codeLinesPerBlock: CODE_LINES_PER_BLOCK,
              streamingChars: streamingText.length,
              diffLines: DIFF_LINES,
              diffRows,
            },
            metrics: getStreamingPerformanceSnapshot(),
          };
          document.body.setAttribute('data-chat-perf-ready', 'true');
        });
      });
    }, 100);

    return () => window.clearTimeout(timer);
  }, [streamingText.length]);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <section className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">Chat Render Browser Perf</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Real browser mount of MessageContent streaming, long code blocks, and DiffView.
          </p>
        </div>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Streaming Text</h2>
          <MessageContent
            content={streamingText}
            isUser={false}
            isStreaming
            messageId="browser-perf-streaming"
          />
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Long Code Markdown</h2>
          <MessageContent
            content={markdown}
            isUser={false}
            isStreaming={false}
            messageId="browser-perf-code"
          />
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-chat-browser-diff>
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Large Diff</h2>
          <DiffView
            oldText={oldText}
            newText={newText}
            fileName="browser-large-diff.ts"
          />
        </section>
      </section>
    </main>
  );
}

function main(): void {
  resetStreamingPerformanceMetrics();
  installLongTaskObserver();
  window.__CHAT_RENDER_BROWSER_STARTED_AT__ = performance.now();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing #root for chat render browser harness.');
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <BrowserHarness />
    </React.StrictMode>,
  );
}

main();
