import React, { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CodeBlock,
  MessageContent,
} from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  getStreamingPerformanceSnapshot,
  resetStreamingPerformanceMetrics,
} from '../../src/renderer/utils/streamingPerformanceMetrics';

interface CodeHighlightBrowserPhase {
  durationMs: number;
  longTasks: Array<{ name: string; startTime: number; duration: number }>;
  rendered: Record<string, unknown>;
  metrics: ReturnType<typeof getStreamingPerformanceSnapshot>;
}

declare global {
  interface Window {
    __CODE_HIGHLIGHT_BROWSER_STARTED_AT__?: number;
    __CODE_HIGHLIGHT_BROWSER_LONG_TASKS__?: CodeHighlightBrowserPhase['longTasks'];
    __CODE_HIGHLIGHT_BROWSER_INITIAL__?: CodeHighlightBrowserPhase;
    __CODE_HIGHLIGHT_BROWSER_RESET__?: () => void;
    __CODE_HIGHLIGHT_BROWSER_COLLECT__?: (startedAt: number) => CodeHighlightBrowserPhase;
  }
}

const COLLAPSED_BLOCKS = 10;
const COLLAPSED_LINES_PER_BLOCK = 500;
const EXPAND_1000_LINES = 1_000;
const EXPAND_5000_LINES = 5_000;

function makeCodeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `export const ${prefix}_${n} = { id: ${n}, label: "${prefix}-${n}", enabled: ${n % 2 === 0} };`;
  }).join('\n');
}

function makeMarkdownWithCodeBlocks(blockCount: number, linesPerBlock: number): string {
  return Array.from({ length: blockCount }, (_, index) => [
    `### Code highlight collapsed block ${index + 1}`,
    '',
    '```ts',
    makeCodeLines(`collapsed_block_${index + 1}`, linesPerBlock),
    '```',
  ].join('\n')).join('\n\n');
}

function collectRendered(): Record<string, unknown> {
  return {
    plainPreviews: document.querySelectorAll('[data-code-preview="plain"]').length,
    expanded1000LastLinePresent: document.body.textContent?.includes('expand_1000_1000') ?? false,
    expanded5000LastLinePresent: document.body.textContent?.includes('expand_5000_5000') ?? false,
  };
}

function collectPhase(startedAt: number): CodeHighlightBrowserPhase {
  return {
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    longTasks: [...(window.__CODE_HIGHLIGHT_BROWSER_LONG_TASKS__ ?? [])],
    rendered: collectRendered(),
    metrics: getStreamingPerformanceSnapshot(),
  };
}

function installLongTaskObserver(): void {
  window.__CODE_HIGHLIGHT_BROWSER_LONG_TASKS__ = [];
  window.__CODE_HIGHLIGHT_BROWSER_RESET__ = () => {
    window.__CODE_HIGHLIGHT_BROWSER_LONG_TASKS__ = [];
    resetStreamingPerformanceMetrics();
  };
  window.__CODE_HIGHLIGHT_BROWSER_COLLECT__ = collectPhase;

  if (!('PerformanceObserver' in window)) return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__CODE_HIGHLIGHT_BROWSER_LONG_TASKS__?.push({
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

function CodeHighlightHarness(): React.ReactElement {
  const collapsedMarkdown = useMemo(
    () => makeMarkdownWithCodeBlocks(COLLAPSED_BLOCKS, COLLAPSED_LINES_PER_BLOCK),
    [],
  );
  const expand1000 = useMemo(() => makeCodeLines('expand_1000', EXPAND_1000_LINES), []);
  const expand5000 = useMemo(() => makeCodeLines('expand_5000', EXPAND_5000_LINES), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.__CODE_HIGHLIGHT_BROWSER_INITIAL__ = collectPhase(
            window.__CODE_HIGHLIGHT_BROWSER_STARTED_AT__ ?? performance.now(),
          );
          document.body.setAttribute('data-code-highlight-ready', 'true');
        });
      });
    }, 100);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">Code Highlight Browser Perf</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Isolated MessageContent and CodeBlock expand performance fixture.
          </p>
        </div>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-code-fixture="collapsed-10x500">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">10 Collapsed 500-Line Blocks</h2>
          <MessageContent
            content={collapsedMarkdown}
            isUser={false}
            isStreaming={false}
            messageId="code-highlight-collapsed"
          />
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-code-fixture="expand-1000">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Expand 1000-Line CodeBlock</h2>
          <CodeBlock language="ts" code={expand1000} />
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-code-fixture="expand-5000">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Expand 5000-Line CodeBlock</h2>
          <CodeBlock language="ts" code={expand5000} />
        </section>
      </section>
    </main>
  );
}

function main(): void {
  resetStreamingPerformanceMetrics();
  installLongTaskObserver();
  window.__CODE_HIGHLIGHT_BROWSER_STARTED_AT__ = performance.now();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing #root for code highlight browser harness.');
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <CodeHighlightHarness />
    </React.StrictMode>,
  );
}

main();
