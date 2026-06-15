import React, { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { DiffView } from '../../src/renderer/components/DiffView';
import { TurnDiffSummary } from '../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary';
import {
  getStreamingPerformanceSnapshot,
  resetStreamingPerformanceMetrics,
} from '../../src/renderer/utils/streamingPerformanceMetrics';
import type { TraceTurn } from '../../src/shared/contract/trace';

interface DiffRenderBrowserPhase {
  durationMs: number;
  longTasks: Array<{ name: string; startTime: number; duration: number }>;
  rows: Record<string, number>;
  metrics: ReturnType<typeof getStreamingPerformanceSnapshot>;
}

declare global {
  interface Window {
    __DIFF_RENDER_BROWSER_STARTED_AT__?: number;
    __DIFF_RENDER_BROWSER_LONG_TASKS__?: DiffRenderBrowserPhase['longTasks'];
    __DIFF_RENDER_BROWSER_INITIAL__?: DiffRenderBrowserPhase;
    __DIFF_RENDER_BROWSER_RESET__?: () => void;
    __DIFF_RENDER_BROWSER_COLLECT__?: (startedAt: number) => DiffRenderBrowserPhase;
  }
}

const SINGLE_DIFF_LINES = 5_000;
const SUMMARY_FILES = 3;
const SUMMARY_LINES_PER_FILE = 1_000;

function makeTextLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `${prefix} line ${n} value_${n}`;
  }).join('\n');
}

function makeDiffTurn(fileCount: number, linesPerFile: number): TraceTurn {
  const nodes: TraceTurn['nodes'] = [];
  for (let index = 0; index < fileCount; index += 1) {
    nodes.push({
      id: `diff-render-edit-${index + 1}`,
      type: 'tool_call',
      content: '',
      timestamp: 1_780_000_100_000 + index,
      toolCall: {
        id: `diff-render-tool-${index + 1}`,
        name: 'Edit',
        args: {
          file_path: `/tmp/browser-file-${index + 1}.ts`,
          old_string: makeTextLines(`summary-old-${index + 1}`, linesPerFile),
          new_string: makeTextLines(`summary-new-${index + 1}`, linesPerFile),
        },
        success: true,
      },
    });
  }

  return {
    turnNumber: 1,
    turnId: 'diff-render-turn',
    nodes,
    status: 'streaming',
    startTime: 1_780_000_100_000,
  };
}

function countRows(): Record<string, number> {
  return {
    singleDiffRows: document.querySelectorAll('[data-single-diff] tbody tr').length,
    summaryDiffRows: document.querySelectorAll('[data-diff-summary-smoke] .diff-view tbody tr').length,
    totalDiffRows: document.querySelectorAll('.diff-view tbody tr').length,
  };
}

function collectPhase(startedAt: number): DiffRenderBrowserPhase {
  return {
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    longTasks: [...(window.__DIFF_RENDER_BROWSER_LONG_TASKS__ ?? [])],
    rows: countRows(),
    metrics: getStreamingPerformanceSnapshot(),
  };
}

function installLongTaskObserver(): void {
  window.__DIFF_RENDER_BROWSER_LONG_TASKS__ = [];
  window.__DIFF_RENDER_BROWSER_RESET__ = () => {
    window.__DIFF_RENDER_BROWSER_LONG_TASKS__ = [];
    resetStreamingPerformanceMetrics();
  };
  window.__DIFF_RENDER_BROWSER_COLLECT__ = collectPhase;

  if (!('PerformanceObserver' in window)) return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__DIFF_RENDER_BROWSER_LONG_TASKS__?.push({
          name: entry.name,
          startTime: Math.round(entry.startTime * 1000) / 1000,
          duration: Math.round(entry.duration * 1000) / 1000,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Browser support varies; the row counts and timing still remain useful.
  }
}

function DiffRenderHarness(): React.ReactElement {
  const oldText = useMemo(() => makeTextLines('single-old', SINGLE_DIFF_LINES), []);
  const newText = useMemo(() => makeTextLines('single-new', SINGLE_DIFF_LINES), []);
  const turn = useMemo(() => makeDiffTurn(SUMMARY_FILES, SUMMARY_LINES_PER_FILE), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.__DIFF_RENDER_BROWSER_INITIAL__ = collectPhase(
            window.__DIFF_RENDER_BROWSER_STARTED_AT__ ?? performance.now(),
          );
          document.body.setAttribute('data-diff-render-ready', 'true');
        });
      });
    }, 100);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">Diff Render Browser Perf</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Isolated DiffView and TurnDiffSummary expansion performance fixture.
          </p>
        </div>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-single-diff>
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Single 5k-Line DiffView</h2>
          <DiffView
            oldText={oldText}
            newText={newText}
            fileName="single-5k-diff.ts"
          />
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4" data-diff-summary-smoke>
          <h2 className="mb-3 text-sm font-medium text-zinc-300">TurnDiffSummary Multi-File</h2>
          <TurnDiffSummary turn={turn} />
        </section>
      </section>
    </main>
  );
}

function main(): void {
  resetStreamingPerformanceMetrics();
  installLongTaskObserver();
  window.__DIFF_RENDER_BROWSER_STARTED_AT__ = performance.now();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing #root for diff render browser harness.');
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <DiffRenderHarness />
    </React.StrictMode>,
  );
}

main();
