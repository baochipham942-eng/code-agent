import { beforeEach, describe, expect, it } from 'vitest';
import type { AppshotCapture } from '../../../src/shared/contract/appshot';
import { useAppshotsStore } from '../../../src/renderer/stores/appshotsStore';

function createCapture(requestId: string): AppshotCapture {
  return {
    requestId,
    appName: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    windowTitle: 'Untitled',
    screenshotPath: `/tmp/${requestId}.png`,
    screenshotDataUrl: 'data:image/png;base64,abc',
    axText: 'draft text',
    textSource: 'ax',
    windowFrame: { x: 0, y: 0, width: 400, height: 300 },
    capturedAtMs: 100,
  };
}

describe('appshotsStore', () => {
  beforeEach(() => {
    useAppshotsStore.getState().clear();
  });

  it('binds a pending capture to the session that created it', () => {
    const capture = createCapture('appshot-1');

    useAppshotsStore.getState().setPending(capture, 'session-a');

    expect(useAppshotsStore.getState()).toMatchObject({
      pending: capture,
      pendingSessionId: 'session-a',
      starting: false,
      startingSessionId: null,
    });
  });

  it('remembers the session at capture start while native capture is in flight', () => {
    useAppshotsStore.getState().setStarting(true, 'session-a');

    expect(useAppshotsStore.getState()).toMatchObject({
      starting: true,
      startingSessionId: 'session-a',
    });

    useAppshotsStore.getState().setPending(createCapture('appshot-2'), 'session-a');

    expect(useAppshotsStore.getState()).toMatchObject({
      pendingSessionId: 'session-a',
      starting: false,
      startingSessionId: null,
    });
  });

  it('clears pending capture and capture-start scope together', () => {
    useAppshotsStore.getState().setStarting(true, 'session-a');
    useAppshotsStore.getState().setPending(createCapture('appshot-3'), 'session-a');

    useAppshotsStore.getState().clear();

    expect(useAppshotsStore.getState()).toMatchObject({
      pending: null,
      pendingSessionId: null,
      starting: false,
      startingSessionId: null,
    });
  });
});

describe('appshotsStore motion phases', () => {
  beforeEach(() => {
    useAppshotsStore.getState().clear();
  });

  it('starting → image_ready 进 reserved → handoff 进 visible，全程不丢 requestId', () => {
    const capture = createCapture('appshot-10');

    useAppshotsStore.getState().setStarting(true, 'session-a');
    expect(useAppshotsStore.getState().phase).toBe('starting');

    useAppshotsStore.getState().setImageReady(capture, 'session-a');
    expect(useAppshotsStore.getState()).toMatchObject({
      pending: capture,
      pendingSessionId: 'session-a',
      starting: false,
      startingSessionId: null,
      phase: 'reserved',
    });

    useAppshotsStore.getState().markHandoff('appshot-10');
    expect(useAppshotsStore.getState().phase).toBe('visible');
    expect(useAppshotsStore.getState().pending?.requestId).toBe('appshot-10');
  });

  it('text_ready 补齐同 requestId 的文本：visible 后到达进 enriched，不替换 pending', () => {
    useAppshotsStore.getState().setImageReady(createCapture('appshot-11'), 'session-a');
    useAppshotsStore.getState().markHandoff('appshot-11');

    useAppshotsStore.getState().patchText('appshot-11', 'late ocr text', 'ocr');

    const state = useAppshotsStore.getState();
    expect(state.phase).toBe('enriched');
    expect(state.pending).toMatchObject({
      requestId: 'appshot-11',
      axText: 'late ocr text',
      textSource: 'ocr',
    });
  });

  it('reserved 期间到达的 text_ready 只补数据，不提前显形', () => {
    useAppshotsStore.getState().setImageReady(createCapture('appshot-12'), 'session-a');

    useAppshotsStore.getState().patchText('appshot-12', 'ax text', 'ax');

    expect(useAppshotsStore.getState().phase).toBe('reserved');
    expect(useAppshotsStore.getState().pending?.axText).toBe('ax text');

    useAppshotsStore.getState().markHandoff('appshot-12');
    expect(useAppshotsStore.getState().phase).toBe('visible');
  });

  it('错 requestId 的 handoff / text / image patch 一律忽略', () => {
    const capture = createCapture('appshot-13');
    useAppshotsStore.getState().setImageReady(capture, 'session-a');

    useAppshotsStore.getState().markHandoff('appshot-other');
    useAppshotsStore.getState().patchText('appshot-other', 'bad', 'ocr');
    useAppshotsStore.getState().patchImage('appshot-other', 'data:image/png;base64,bad');

    const state = useAppshotsStore.getState();
    expect(state.phase).toBe('reserved');
    expect(state.pending).toEqual(capture);
    // 错 id 的 handoff 只暂存，不影响当前 pending
    expect(state.handoffRequestId).toBe('appshot-other');
  });

  it('handoff 先于 image_ready 处理时暂存，setImageReady 直接进 visible', () => {
    useAppshotsStore.getState().markHandoff('appshot-14');
    expect(useAppshotsStore.getState().phase).toBe('idle');

    useAppshotsStore.getState().setImageReady(createCapture('appshot-14'), 'session-a');

    expect(useAppshotsStore.getState().phase).toBe('visible');
    expect(useAppshotsStore.getState().handoffRequestId).toBeNull();
  });

  it('patchImage 把并行读出的 dataURL 补进当前 pending', () => {
    const capture = { ...createCapture('appshot-15'), screenshotDataUrl: undefined };
    useAppshotsStore.getState().setImageReady(capture, 'session-a');

    useAppshotsStore.getState().patchImage('appshot-15', 'data:image/png;base64,ready');

    expect(useAppshotsStore.getState().pending?.screenshotDataUrl).toBe('data:image/png;base64,ready');
  });

  it('setPending 兼容别名直接可见（草稿恢复等无飞入场景）', () => {
    useAppshotsStore.getState().setPending(createCapture('appshot-16'), 'session-a');

    expect(useAppshotsStore.getState().phase).toBe('visible');
  });

  it('clear 复位 phase 与暂存的 handoff', () => {
    useAppshotsStore.getState().markHandoff('appshot-17');
    useAppshotsStore.getState().setImageReady(createCapture('appshot-18'), 'session-a');

    useAppshotsStore.getState().clear();

    expect(useAppshotsStore.getState()).toMatchObject({
      pending: null,
      phase: 'idle',
      handoffRequestId: null,
    });
  });
});
