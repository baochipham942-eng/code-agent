import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Message } from '../../src/shared/contract/message';
import type { TraceTurn } from '../../src/shared/contract/trace';
import { projectTurns } from '../../src/renderer/hooks/useTurnProjection';
import { applyStreamingMessageDeltasToProjection } from '../../src/renderer/utils/streamingProjectionOverlay';
import { buildTurnFileChanges } from '../../src/renderer/utils/turnDiffSummary';
import { diffLinesWithFastPath } from '../../src/renderer/utils/fastDiff';
import { mergeMessageUpdates, type MessageUpdate } from '../../src/renderer/hooks/useMessageBatcher';
import {
  getStreamingPerformanceSnapshot,
  measureStreamingPerformanceTiming,
  resetStreamingPerformanceMetrics,
  type StreamingPerformanceSnapshot,
} from '../../src/renderer/utils/streamingPerformanceMetrics';

interface BenchResult {
  name: string;
  description: string;
  iterations: number;
  samplesMs: number[];
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  output: Record<string, unknown>;
}

interface BaselineReport {
  generatedAt: string;
  environment: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  results: BenchResult[];
  runtimeMetrics: StreamingPerformanceSnapshot;
}

const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
const JSON_OUT = path.join(OUT_DIR, 'chat-render-baseline-latest.json');
const MD_OUT = path.join(OUT_DIR, 'chat-render-baseline-latest.md');
const SESSION_ID = 'perf-chat-render-session';

function runGit(command: string): string {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unavailable';
  }
}

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeSamples(samples: number[]): Omit<BenchResult, 'name' | 'description' | 'iterations' | 'samplesMs' | 'output'> {
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    meanMs: roundMs(total / samples.length),
    minMs: roundMs(Math.min(...samples)),
    maxMs: roundMs(Math.max(...samples)),
    p95Ms: roundMs(percentile(samples, 0.95)),
  };
}

function benchmark(
  name: string,
  description: string,
  fn: () => Record<string, unknown>,
  options: { iterations?: number; warmup?: number } = {},
): BenchResult {
  const iterations = options.iterations ?? 10;
  const warmup = options.warmup ?? 2;
  let output: Record<string, unknown> = {};

  for (let index = 0; index < warmup; index += 1) {
    output = fn();
  }

  const samplesMs: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    output = fn();
    samplesMs.push(performance.now() - startedAt);
  }

  return {
    name,
    description,
    iterations,
    samplesMs: samplesMs.map(roundMs),
    ...summarizeSamples(samplesMs),
    output,
  };
}

function makeCodeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `export const ${prefix}_${n} = { id: ${n}, label: "${prefix}-${n}", enabled: ${n % 2 === 0} };`;
  }).join('\n');
}

function makeMarkdownWithCodeBlocks(blockCount: number, linesPerBlock: number): string {
  return Array.from({ length: blockCount }, (_, index) => [
    `## Perf code block ${index + 1}`,
    '',
    '```ts',
    makeCodeLines(`block_${index + 1}`, linesPerBlock),
    '```',
  ].join('\n')).join('\n\n');
}

function makeTextLines(prefix: string, count: number, mutateEvery = 0): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const suffix = mutateEvery > 0 && n % mutateEvery === 0 ? 'changed' : 'stable';
    return `${prefix} line ${n} ${suffix}`;
  }).join('\n');
}

function makeMessages(turnCount: number, options: { codeEvery?: number; codeLines?: number } = {}): Message[] {
  const messages: Message[] = [];
  const startedAt = 1_780_000_000_000;

  for (let index = 0; index < turnCount; index += 1) {
    const n = index + 1;
    messages.push({
      id: `user-${n}`,
      role: 'user',
      content: `Inspect render scenario ${n}.`,
      timestamp: startedAt + n * 2000,
    });

    const includeCode = options.codeEvery && n % options.codeEvery === 0;
    const content = includeCode
      ? [
          `Result for turn ${n}.`,
          '',
          '```ts',
          makeCodeLines(`turn_${n}`, options.codeLines ?? 40),
          '```',
        ].join('\n')
      : `Result for turn ${n}. `.repeat(8);

    messages.push({
      id: `assistant-${n}`,
      role: 'assistant',
      content,
      timestamp: startedAt + n * 2000 + 750,
    });
  }

  return messages;
}

function makeStreamingMessages(baseTurns: number): { messages: Message[]; messageId: string; delta: string } {
  const messages = makeMessages(baseTurns);
  const next = baseTurns + 1;
  const messageId = `assistant-${next}`;
  messages.push({
    id: `user-${next}`,
    role: 'user',
    content: 'Stream a long answer with markdown and code.',
    timestamp: 1_780_000_000_000 + next * 2000,
  });
  messages.push({
    id: messageId,
    role: 'assistant',
    content: '',
    timestamp: 1_780_000_000_000 + next * 2000 + 750,
  });

  return {
    messages,
    messageId,
    delta: `${'Streaming paragraph with /path/to/file.ts and **markdown**. '.repeat(260)}\n\n\`\`\`ts\n${makeCodeLines('streaming', 120)}\n\`\`\`\n`,
  };
}

function makeDiffTurn(fileCount: number, linesPerFile: number): TraceTurn {
  const nodes: TraceTurn['nodes'] = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    nodes.push({
      id: `edit-${fileIndex + 1}`,
      type: 'tool_call',
      content: '',
      timestamp: 1_780_000_010_000 + fileIndex,
      toolCall: {
        id: `tc-${fileIndex + 1}`,
        name: 'Edit',
        args: {
          file_path: `/tmp/perf-file-${fileIndex + 1}.ts`,
          old_string: makeTextLines(`old-${fileIndex + 1}`, linesPerFile, 0),
          new_string: makeTextLines(`new-${fileIndex + 1}`, linesPerFile, 10),
        },
        success: true,
      },
    });
  }

  return {
    turnNumber: 1,
    turnId: 'diff-turn',
    nodes,
    status: 'completed',
    startTime: 1_780_000_010_000,
    endTime: 1_780_000_010_000 + fileCount,
  };
}

const highlighterComponent = SyntaxHighlighter as unknown as React.ComponentType<Record<string, unknown>>;

function MarkdownHighlightHarness({ content }: { content: string }): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children }) {
          const language = /language-(\w+)/.exec(className || '')?.[1] || 'text';
          const code = String(children).replace(/\n$/, '');
          const lines = code.split('\n');
          const displayCode = lines.length > 25 ? lines.slice(0, 25).join('\n') : code;
          if (!className) {
            return <code>{children}</code>;
          }
          if (lines.length > 25) {
            return <pre><code>{displayCode}</code></pre>;
          }
          return React.createElement(
            highlighterComponent,
            {
              style: oneDark,
              language,
              showLineNumbers: lines.length > 3,
              customStyle: {
                margin: 0,
                padding: '1rem',
                background: 'transparent',
                fontSize: '0.75rem',
                lineHeight: '1.25rem',
              },
            },
            displayCode,
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function renderMarkdownWithHighlight(content: string): { htmlLength: number } {
  const html = measureStreamingPerformanceTiming(
    'stream.markdown.render_ms',
    () => renderToStaticMarkup(<MarkdownHighlightHarness content={content} />),
  );
  return { htmlLength: html.length };
}

function buildReport(options: { deep: boolean }): BaselineReport {
  resetStreamingPerformanceMetrics();
  const messages100 = makeMessages(100, { codeEvery: 10, codeLines: 80 });
  const messages1000 = makeMessages(1000, { codeEvery: 25, codeLines: 80 });
  const streaming = makeStreamingMessages(999);
  const streamingProjection = projectTurns(streaming.messages, SESSION_ID, true, []);
  const diffTurn = makeDiffTurn(10, 500);
  const rawOld = makeTextLines('raw-old', 5000, 0);
  const rawNew = makeTextLines('raw-new', 5000, 10);
  const markdown = makeMarkdownWithCodeBlocks(10, 500);
  const streamingChunks: MessageUpdate[] = Array.from({ length: 200 }, (_, index) => ({
    type: 'append',
    messageId: streaming.messageId,
    content: streaming.delta.slice(index * 100, (index + 1) * 100),
  }));

  const results: BenchResult[] = [
    benchmark(
      'projectTurns.100-turns',
      'Project 100 user/assistant turns into TurnBasedTraceView data.',
      () => {
        const projection = projectTurns(messages100, SESSION_ID, false, []);
        return {
          turns: projection.turns.length,
          activeTurnIndex: projection.activeTurnIndex,
          nodes: projection.turns.reduce((sum, turn) => sum + turn.nodes.length, 0),
        };
      },
      { iterations: 20 },
    ),
    benchmark(
      'projectTurns.1000-turns',
      'Project 1000 user/assistant turns into TurnBasedTraceView data.',
      () => {
        const projection = projectTurns(messages1000, SESSION_ID, false, []);
        return {
          turns: projection.turns.length,
          activeTurnIndex: projection.activeTurnIndex,
          nodes: projection.turns.reduce((sum, turn) => sum + turn.nodes.length, 0),
        };
      },
      { iterations: 10 },
    ),
    benchmark(
      'streamingOverlay.20k-delta',
      'Apply one active 20k-ish streaming delta over a 1000-turn projection.',
      () => {
        const projection = applyStreamingMessageDeltasToProjection(
          streamingProjection,
          streaming.messages,
          {
            [streaming.messageId]: {
              contentDelta: streaming.delta,
              reasoningDelta: '',
              updatedAt: Date.now(),
            },
          },
        );
        const active = projection.turns[projection.turns.length - 1];
        return {
          turns: projection.turns.length,
          activeNodes: active?.nodes.length ?? 0,
          deltaChars: streaming.delta.length,
        };
      },
      { iterations: 20 },
    ),
    benchmark(
      'streamingBatcher.20k-append-chunks',
      'Merge 200 append updates into the same assistant message.',
      () => {
        const merged = mergeMessageUpdates(streamingChunks);
        return {
          inputUpdates: streamingChunks.length,
          mergedUpdates: merged.length,
          mergedChars: merged[0]?.type === 'append' ? merged[0].content?.length ?? 0 : 0,
        };
      },
      { iterations: 50 },
    ),
    benchmark(
      'turnDiffSummary.10-files-500-lines',
      'Build TurnDiffSummary data for 10 edited files, 500 lines each.',
      () => {
        const changes = buildTurnFileChanges(diffTurn);
        return {
          fileCount: changes.length,
          added: changes.reduce((sum, item) => sum + item.added, 0),
          removed: changes.reduce((sum, item) => sum + item.removed, 0),
        };
      },
      { iterations: options.deep ? 10 : 5 },
    ),
    benchmark(
      'diffLines.5000-lines',
      'Run the renderer diff-lines path for a 5000-line file pair.',
      () => {
        const changes = measureStreamingPerformanceTiming(
          'stream.diff.lines_ms',
          () => diffLinesWithFastPath(rawOld, rawNew),
        );
        return {
          chunks: changes.length,
          addedChunks: changes.filter((change) => change.added).length,
          removedChunks: changes.filter((change) => change.removed).length,
        };
      },
      { iterations: options.deep ? 10 : 3 },
    ),
    benchmark(
      'markdownHighlight.10x500-line-code-blocks',
      'Server-render ReactMarkdown with the current collapsed long-code preview path.',
      () => renderMarkdownWithHighlight(markdown),
      { iterations: options.deep ? 5 : 2, warmup: 1 },
    ),
  ];

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      gitHead: runGit('git rev-parse --short HEAD'),
      dirtyEntries: Number(runGit('git status --short --untracked-files=all | wc -l')) || 0,
      packageVersion: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version,
      mode: options.deep ? 'deep' : 'quick',
    },
    fixtures: {
      turnCounts: [100, 1000],
      streamingDeltaChars: streaming.delta.length,
      codeBlocks: { count: 10, linesPerBlock: 500 },
      diffFiles: { count: 10, linesPerFile: 500 },
      rawDiffLines: 5000,
    },
    results,
    runtimeMetrics: getStreamingPerformanceSnapshot(),
  };
}

function formatMarkdown(report: BaselineReport): string {
  const rows = report.results
    .map((result) => `| ${result.name} | ${result.meanMs} | ${result.p95Ms} | ${result.maxMs} | ${result.iterations} | ${JSON.stringify(result.output)} |`)
    .join('\n');
  const timingRows = Object.entries(report.runtimeMetrics.timings)
    .map(([name, timing]) => `| ${name} | ${timing.count} | ${timing.meanMs} | ${timing.p95Ms} | ${timing.maxMs} | ${timing.lastMs} |`)
    .join('\n');

  return [
    '# Chat Render Performance Baseline',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Environment',
    '',
    `- Node: ${report.environment.node}`,
    `- Platform: ${report.environment.platform}/${report.environment.arch}`,
    `- Package version: ${report.environment.packageVersion}`,
    `- Mode: ${report.environment.mode}`,
    `- Git HEAD: ${report.environment.gitHead}`,
    `- Dirty entries at run: ${report.environment.dirtyEntries}`,
    '',
    '## Fixtures',
    '',
    `- Turns: ${(report.fixtures.turnCounts as number[]).join(', ')}`,
    `- Streaming delta chars: ${report.fixtures.streamingDeltaChars}`,
    `- Code blocks: ${JSON.stringify(report.fixtures.codeBlocks)}`,
    `- Diff files: ${JSON.stringify(report.fixtures.diffFiles)}`,
    `- Raw diff lines: ${report.fixtures.rawDiffLines}`,
    '',
    '## Results',
    '',
    '| Benchmark | Mean ms | P95 ms | Max ms | Iterations | Output |',
    '|---|---:|---:|---:|---:|---|',
    rows,
    '',
    '## Runtime Metrics Snapshot',
    '',
    '| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |',
    '|---|---:|---:|---:|---:|---:|',
    timingRows || '| none | 0 | 0 | 0 | 0 | 0 |',
    '',
    '## Interpretation Notes',
    '',
    '- This is a synthetic renderer-path baseline. It measures pure projection, streaming overlay, diff preparation, raw diffing, and markdown/highlight rendering with the current dependency stack.',
    '- Browser long-task evidence is captured separately by `npx tsx scripts/perf/chat-render-browser-smoke.ts`.',
    '- Keep this file as the before/after comparison anchor for chat-render optimization passes.',
    '',
  ].join('\n');
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = buildReport({ deep: process.argv.includes('--deep') });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, formatMarkdown(report));

  console.log(`Wrote ${path.relative(process.cwd(), JSON_OUT)}`);
  console.log(`Wrote ${path.relative(process.cwd(), MD_OUT)}`);
  for (const result of report.results) {
    console.log(`${result.name}: mean=${result.meanMs}ms p95=${result.p95Ms}ms max=${result.maxMs}ms`);
  }
}

main();
