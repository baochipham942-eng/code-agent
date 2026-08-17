import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffView } from '../../../src/renderer/components/DiffView';

type RendererId = 'current' | 'codemirror' | 'pierre';

interface Fixture {
  id: string;
  label: string;
  kind: string;
  oldText: string;
  newText: string;
  provenance: Record<string, unknown>;
}

interface ScrollTiming {
  frameCount: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface HarnessResult {
  renderer: RendererId;
  fixture: string;
  fixtureLabel: string;
  firstFrameMs: number;
  fullRenderMs: number;
  longestMountFrameMs: number;
  mountFrameP95Ms: number;
  scrollMid: ScrollTiming;
  scrollBottom: ScrollTiming;
  renderedDomRows: number;
  scrollHeight: number;
  logicalOldLines: number;
  logicalNewLines: number;
}

declare global {
  interface Window {
    __DIFFBENCH_RESULT__?: HarnessResult;
    __DIFFBENCH_ERROR__?: string;
    __DIFFBENCH_PHASE__?: string;
  }
}

const round = (value: number) => Math.round(value * 1_000) / 1_000;
const requestedRenderer = new URLSearchParams(window.location.search).get('renderer');
const codeMirrorModules = requestedRenderer === 'codemirror'
  ? await Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/merge'),
    ])
  : null;
const pierreModules = requestedRenderer === 'pierre'
  ? await Promise.all([import('@pierre/diffs'), import('@pierre/diffs/react')])
  : null;

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarizeFrames(values: number[]): ScrollTiming {
  return {
    frameCount: values.length,
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(0, ...values)),
  };
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms while waiting for renderer state`);
    }
    await nextFrame();
  }
}

function startFrameSampler(startedAt: number) {
  const frames: number[] = [];
  let last = startedAt;
  let active = true;
  let frameId = requestAnimationFrame(function sample(now) {
    frames.push(now - last);
    last = now;
    if (active) frameId = requestAnimationFrame(sample);
  });
  return {
    frames,
    stop() {
      active = false;
      cancelAnimationFrame(frameId);
    },
  };
}

async function waitForStableCompletion(
  isComplete: () => boolean,
  signature: () => string,
): Promise<void> {
  await waitUntil(isComplete, 60_000);
  let stableFrames = 0;
  let previous = signature();
  while (stableFrames < 3) {
    await nextFrame();
    const current = signature();
    if (current === previous) stableFrames += 1;
    else stableFrames = 0;
    previous = current;
  }
}

function makeFile(name: string, contents: string, cacheKey: string) {
  return { name, contents, lang: 'text' as const, cacheKey };
}

function mountCurrent(rootNode: HTMLElement, fixture: Fixture) {
  const reactRoot = createRoot(rootNode);
  reactRoot.render(
    <DiffView
      oldText={fixture.oldText}
      newText={fixture.newText}
      fileName={`${fixture.id}.ts`}
    />,
  );
  return {
    isFirstPaint: () => rootNode.querySelector('tbody tr') !== null,
    isComplete: () => rootNode.querySelector('[data-diff-render-complete="true"]') !== null,
    cleanup: () => reactRoot.unmount(),
  };
}

function mountCodeMirror(rootNode: HTMLElement, fixture: Fixture) {
  if (!codeMirrorModules) throw new Error('CodeMirror modules were not preloaded');
  const [{ EditorState }, { EditorView, lineNumbers }, { unifiedMergeView }] = codeMirrorModules;
  const view = new EditorView({
    parent: rootNode,
    doc: fixture.newText,
    extensions: [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        '&': { height: '100%', fontSize: '12px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace' },
      }),
      unifiedMergeView({
        original: fixture.oldText,
        highlightChanges: false,
        gutter: true,
        allowInlineDiffs: false,
        mergeControls: false,
      }),
    ],
  });
  return {
    isFirstPaint: () => rootNode.querySelector('.cm-line') !== null,
    isComplete: () => rootNode.querySelector('.cm-content') !== null,
    cleanup: () => view.destroy(),
  };
}

function PierreSurface({ fixture, onPostRender }: {
  fixture: Fixture;
  onPostRender: () => void;
}) {
  if (!pierreModules) throw new Error('Pierre modules were not preloaded');
  const [{ parseDiffFromFile }, { FileDiff: PierreFileDiff }] = pierreModules;
  const oldFile = fixture.oldText === ''
    ? null
    : makeFile(`${fixture.id}.txt`, fixture.oldText, `${fixture.id}:old`);
  const newFile = makeFile(`${fixture.id}.txt`, fixture.newText, `${fixture.id}:new`);
  const context = Math.max(countLines(fixture.oldText), countLines(fixture.newText)) + 1;
  const fileDiff = parseDiffFromFile(oldFile, newFile, { context });
  return (
    <PierreFileDiff
      fileDiff={fileDiff}
      disableWorkerPool
      options={{
        diffStyle: 'unified',
        diffIndicators: 'classic',
        expandUnchanged: true,
        lineDiffType: 'none',
        overflow: 'scroll',
        themeType: 'dark',
        tokenizeMaxLength: 0,
        tokenizeMaxLineLength: 0,
        onPostRender,
      }}
    />
  );
}

function mountPierre(rootNode: HTMLElement, fixture: Fixture) {
  let postRenderCount = 0;
  const reactRoot: Root = createRoot(rootNode);
  reactRoot.render(
    <PierreSurface fixture={fixture} onPostRender={() => { postRenderCount += 1; }} />,
  );
  const renderedLines = () => rootNode
    .querySelector<HTMLElement>('diffs-container')
    ?.shadowRoot
    ?.querySelectorAll('[data-line]').length ?? 0;
  return {
    isFirstPaint: () => renderedLines() > 0,
    isComplete: () => postRenderCount > 0 && renderedLines() > 0,
    cleanup: () => reactRoot.unmount(),
  };
}

function pickScrollTarget(renderer: RendererId, wrapper: HTMLElement): HTMLElement {
  if (renderer === 'codemirror') {
    return wrapper.querySelector<HTMLElement>('.cm-scroller') ?? wrapper;
  }
  return wrapper;
}

async function animateScroll(target: HTMLElement, fraction: number): Promise<ScrollTiming> {
  const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
  const start = target.scrollTop;
  const destination = maximum * fraction;
  const frames: number[] = [];
  let previous = performance.now();

  for (let step = 1; step <= 18; step += 1) {
    const now = await nextFrame();
    frames.push(now - previous);
    previous = now;
    target.scrollTop = start + ((destination - start) * step / 18);
  }
  const settledAt = await nextFrame();
  frames.push(settledAt - previous);
  return summarizeFrames(frames);
}

function renderedDomRows(renderer: RendererId, wrapper: HTMLElement): number {
  if (renderer === 'current') return wrapper.querySelectorAll('tbody tr').length;
  if (renderer === 'codemirror') return wrapper.querySelectorAll('.cm-line').length;
  return wrapper
    .querySelector<HTMLElement>('diffs-container')
    ?.shadowRoot
    ?.querySelectorAll('[data-line]').length ?? 0;
}

async function run(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const renderer = query.get('renderer') as RendererId | null;
  const fixtureId = query.get('fixture');
  if (!renderer || !['current', 'codemirror', 'pierre'].includes(renderer)) {
    throw new Error(`Unknown renderer: ${String(renderer)}`);
  }
  if (!fixtureId || !/^[a-z0-9-]+$/.test(fixtureId)) {
    throw new Error(`Invalid fixture: ${String(fixtureId)}`);
  }

  window.__DIFFBENCH_PHASE__ = 'loading-fixture';
  const response = await fetch(`/tests/eval/diffbench/fixtures/${fixtureId}.json`);
  if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`);
  const fixture = await response.json() as Fixture;
  const wrapper = document.querySelector<HTMLElement>('#bench-scroll');
  const rootNode = document.querySelector<HTMLElement>('#root');
  if (!wrapper || !rootNode) throw new Error('Harness mount nodes are missing');

  window.__DIFFBENCH_PHASE__ = 'mounting';
  const startedAt = performance.now();
  const sampler = startFrameSampler(startedAt);
  const mounted = renderer === 'current'
    ? mountCurrent(rootNode, fixture)
    : renderer === 'codemirror'
      ? mountCodeMirror(rootNode, fixture)
      : mountPierre(rootNode, fixture);

  await waitUntil(mounted.isFirstPaint, 60_000);
  await nextFrame();
  const firstFrameMs = performance.now() - startedAt;
  window.__DIFFBENCH_PHASE__ = 'completing';
  await waitForStableCompletion(
    mounted.isComplete,
    () => `${rootNode.innerHTML.length}:${rootNode.querySelectorAll('*').length}`,
  );
  const fullRenderMs = performance.now() - startedAt;
  sampler.stop();

  window.__DIFFBENCH_PHASE__ = 'scrolling';
  const scrollTarget = pickScrollTarget(renderer, wrapper);
  scrollTarget.scrollTop = 0;
  await nextFrame();
  const scrollMid = await animateScroll(scrollTarget, 0.5);
  const scrollBottom = await animateScroll(scrollTarget, 1);

  const result: HarnessResult = {
    renderer,
    fixture: fixture.id,
    fixtureLabel: fixture.label,
    firstFrameMs: round(firstFrameMs),
    fullRenderMs: round(fullRenderMs),
    longestMountFrameMs: round(Math.max(0, ...sampler.frames)),
    mountFrameP95Ms: round(percentile(sampler.frames, 0.95)),
    scrollMid,
    scrollBottom,
    renderedDomRows: renderedDomRows(renderer, wrapper),
    scrollHeight: scrollTarget.scrollHeight,
    logicalOldLines: countLines(fixture.oldText),
    logicalNewLines: countLines(fixture.newText),
  };
  mounted.cleanup();
  window.__DIFFBENCH_RESULT__ = result;
  window.__DIFFBENCH_PHASE__ = 'done';
  document.body.dataset.diffbenchDone = 'true';
}

run().catch((error: unknown) => {
  window.__DIFFBENCH_ERROR__ = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__DIFFBENCH_PHASE__ = 'error';
  document.body.dataset.diffbenchDone = 'error';
  console.error(error);
});
