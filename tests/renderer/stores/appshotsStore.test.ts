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
