import React, { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Components } from 'react-markdown';
import { useSmoothStreamingText } from '../../../src/renderer/hooks/useSmoothStreamingText';
import {
  shouldRenderStreamingContentAsMarkdown,
  useThrottledStreamingContent,
} from '../../../src/renderer/hooks/useThrottledStreamingContent';
import {
  CodeBlock,
  InlineCode,
  MarkdownRenderer,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
// spike 阶段的 Convex 候选对拍已完成并入档（N-L5-PACING/SMOOTHSWAP 证据档）；
// 算法已移植进 useSmoothStreamingText，临时包已卸载，'convex' 模式随之退役。
import '../../../src/renderer/styles/global.css';

export type PacingMode = 'smooth' | 'direct';
export type PipelineMode = 'production' | 'comparison';

export interface ProfilerSample {
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

export interface PaintSample {
  contentLength: number;
  commitAt: number;
  paintAt: number;
  targetUpdatedAt: number | null;
}

export interface FlushSample {
  firstArrivalAt: number;
  lastArrivalAt: number;
  chunkCount: number;
  charCount: number;
  startedAt: number;
  endedAt: number;
}

export interface HarnessResult {
  mode: PacingMode;
  pipeline: PipelineMode;
  startedAt: number;
  inputStoppedAt: number;
  convergedAt: number;
  arrivalTimes: number[];
  visibleTimes: number[];
  flushes: FlushSample[];
  profiler: ProfilerSample[];
  paints: PaintSample[];
  rafGaps: number[];
  longTasks: number[];
  batcherTextPathCalls: number;
}

interface RunState extends HarnessResult {
  pendingText: string;
  pendingFirstArrivalAt: number | null;
  pendingLastArrivalAt: number | null;
  pendingChunkCount: number;
  flushTimer: number | null;
  resolve: ((result: HarnessResult) => void) | null;
  stopped: boolean;
}

interface HarnessApi {
  reset(options: { mode: PacingMode; pipeline: PipelineMode }): void;
  push(chunk: string): void;
  stop(): Promise<HarnessResult>;
  getProgress(): { targetLength: number; displayLength: number };
}

declare global {
  interface Window { pacing?: HarnessApi }
}

const ACCUMULATOR_THROTTLE_MS = 150;

const markdownComponents: Components = {
  code({ node, className, children }) {
    const value = String(children).replace(/\n$/, '');
    const block = node?.position?.start.line !== node?.position?.end.line || className?.startsWith('language-');
    if (block) return <CodeBlock language={className?.replace('language-', '') ?? ''} code={value} />;
    return <InlineCode>{children}</InlineCode>;
  },
  pre({ children }) { return <>{children}</>; },
};

function DirectText({ content }: { content: string }) {
  return { displayContent: content, isAnimating: false };
}

function RenderedText({
  content,
  isStreaming,
  mode,
  onDisplay,
}: {
  content: string;
  isStreaming: boolean;
  mode: PacingMode;
  onDisplay: (length: number) => void;
}) {
  const smooth = useSmoothStreamingText({ content, isStreaming });
  const direct = DirectText({ content });
  const selected = mode === 'smooth' ? smooth : direct;
  const markdown = shouldRenderStreamingContentAsMarkdown(selected.displayContent);
  const renderedContent = useThrottledStreamingContent(
    selected.displayContent,
    isStreaming && markdown,
  );

  useLayoutEffect(() => {
    onDisplay(renderedContent.length);
  }, [onDisplay, renderedContent.length]);

  return (
    <main id="surface" className="mx-auto max-w-4xl p-8 text-zinc-200" data-display-length={renderedContent.length}>
      <MarkdownRenderer content={renderedContent} components={markdownComponents} isStreaming={isStreaming || selected.isAnimating} />
    </main>
  );
}

function Harness() {
  const [target, setTarget] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [mode, setMode] = useState<PacingMode>('smooth');
  const [pipeline, setPipeline] = useState<PipelineMode>('production');
  const [epoch, setEpoch] = useState(0);
  const targetUpdatedAtRef = useRef<number | null>(null);
  const displayLengthRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const observerRef = useRef<PerformanceObserver | null>(null);
  const runRef = useRef<RunState | null>(null);

  const stopFrameLoop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lastFrameAtRef.current = null;
  }, []);

  const startFrameLoop = useCallback(() => {
    stopFrameLoop();
    const tick = (timestamp: number) => {
      const run = runRef.current;
      if (!run) return;
      if (lastFrameAtRef.current !== null) run.rafGaps.push(timestamp - lastFrameAtRef.current);
      lastFrameAtRef.current = timestamp;
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [stopFrameLoop]);

  const finishIfConverged = useCallback((length: number, paintAt: number) => {
    const run = runRef.current;
    if (!run || !run.stopped || length !== run.arrivalTimes.length) return;
    run.convergedAt = paintAt;
    stopFrameLoop();
    observerRef.current?.disconnect();
    observerRef.current = null;
    const resolve = run.resolve;
    run.resolve = null;
    resolve?.(run);
  }, [stopFrameLoop]);

  const onDisplay = useCallback((length: number) => {
    const commitAt = performance.now();
    requestAnimationFrame((paintAt) => {
      const run = runRef.current;
      if (!run) return;
      const previous = displayLengthRef.current;
      if (length > previous) {
        for (let index = previous; index < length; index += 1) run.visibleTimes[index] = paintAt;
      }
      displayLengthRef.current = length;
      run.paints.push({ contentLength: length, commitAt, paintAt, targetUpdatedAt: targetUpdatedAtRef.current });
      performance.mark(`pacing-paint-${run.paints.length}`);
      finishIfConverged(length, paintAt);
    });
  }, [finishIfConverged]);

  const flushAccumulator = useCallback(() => {
    const run = runRef.current;
    if (!run || !run.pendingText) return;
    const startedAt = performance.now();
    performance.mark(`pacing-flush-start-${run.flushes.length}`);
    const text = run.pendingText;
    const sample: FlushSample = {
      firstArrivalAt: run.pendingFirstArrivalAt ?? startedAt,
      lastArrivalAt: run.pendingLastArrivalAt ?? startedAt,
      chunkCount: run.pendingChunkCount,
      charCount: text.length,
      startedAt,
      endedAt: 0,
    };
    run.pendingText = '';
    run.pendingFirstArrivalAt = null;
    run.pendingLastArrivalAt = null;
    run.pendingChunkCount = 0;
    run.flushTimer = null;
    targetUpdatedAtRef.current = startedAt;
    setTarget((current) => current + text);
    sample.endedAt = performance.now();
    run.flushes.push(sample);
    performance.mark(`pacing-flush-end-${run.flushes.length - 1}`);
    performance.measure(`pacing-flush-${run.flushes.length - 1}`, `pacing-flush-start-${run.flushes.length - 1}`, `pacing-flush-end-${run.flushes.length - 1}`);
  }, []);

  const api = useMemo<HarnessApi>(() => ({
    reset(options) {
      if (runRef.current?.flushTimer !== null && runRef.current?.flushTimer !== undefined) {
        clearTimeout(runRef.current.flushTimer);
      }
      performance.clearMarks();
      performance.clearMeasures();
      stopFrameLoop();
      observerRef.current?.disconnect();
      const startedAt = performance.now();
      runRef.current = {
        ...options,
        startedAt,
        inputStoppedAt: 0,
        convergedAt: 0,
        arrivalTimes: [],
        visibleTimes: [],
        flushes: [],
        profiler: [],
        paints: [],
        rafGaps: [],
        longTasks: [],
        batcherTextPathCalls: 0,
        pendingText: '',
        pendingFirstArrivalAt: null,
        pendingLastArrivalAt: null,
        pendingChunkCount: 0,
        flushTimer: null,
        resolve: null,
        stopped: false,
      };
      setMode(options.mode);
      setPipeline(options.pipeline);
      setEpoch((current) => current + 1);
      setTarget('');
      setIsStreaming(true);
      displayLengthRef.current = 0;
      targetUpdatedAtRef.current = null;
      try {
        observerRef.current = new PerformanceObserver((list) => {
          const run = runRef.current;
          if (run) run.longTasks.push(...list.getEntries().map((entry) => entry.duration));
        });
        observerRef.current.observe({ type: 'longtask', buffered: false });
      } catch { observerRef.current = null; }
      startFrameLoop();
    },
    push(chunk) {
      const run = runRef.current;
      if (!run) throw new Error('reset must be called before push');
      const arrivedAt = performance.now();
      for (let index = 0; index < chunk.length; index += 1) run.arrivalTimes.push(arrivedAt);
      if (pipeline === 'comparison' || run.pipeline === 'comparison') {
        targetUpdatedAtRef.current = arrivedAt;
        setTarget((current) => current + chunk);
        return;
      }
      run.pendingText += chunk;
      run.pendingFirstArrivalAt ??= arrivedAt;
      run.pendingLastArrivalAt = arrivedAt;
      run.pendingChunkCount += 1;
      if (run.flushTimer === null) {
        run.flushTimer = window.setTimeout(flushAccumulator, ACCUMULATOR_THROTTLE_MS);
      }
    },
    stop() {
      const run = runRef.current;
      if (!run) return Promise.reject(new Error('reset must be called before stop'));
      run.inputStoppedAt = performance.now();
      run.stopped = true;
      if (run.flushTimer !== null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
        flushAccumulator();
      }
      setIsStreaming(false);
      return new Promise<HarnessResult>((resolve) => {
        run.resolve = resolve;
        if (displayLengthRef.current === run.arrivalTimes.length) {
          requestAnimationFrame((paintAt) => finishIfConverged(displayLengthRef.current, paintAt));
        }
      });
    },
    getProgress() { return { targetLength: target.length, displayLength: displayLengthRef.current }; },
  }), [finishIfConverged, flushAccumulator, pipeline, startFrameLoop, stopFrameLoop, target.length]);

  useEffect(() => { window.pacing = api; }, [api]);

  const onProfilerRender = useCallback((
    _id: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ) => {
    runRef.current?.profiler.push({ phase, actualDuration, baseDuration, startTime, commitTime });
  }, []);

  return (
    <Profiler id="pacing-surface" onRender={onProfilerRender}>
      <RenderedText key={epoch} content={target} isStreaming={isStreaming} mode={mode} onDisplay={onDisplay} />
      <output className="fixed bottom-2 right-2 rounded bg-black/80 px-2 py-1 text-xs text-white">
        {mode} · {pipeline}
      </output>
    </Profiler>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
