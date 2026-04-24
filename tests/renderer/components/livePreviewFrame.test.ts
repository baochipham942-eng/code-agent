import { describe, expect, it } from 'vitest';
import {
  getLivePreviewOrigin,
  isTrustedLivePreviewBridgeEvent,
} from '../../../src/renderer/components/LivePreview/LivePreviewFrame';
import { MESSAGE_SOURCE_BRIDGE } from '../../../src/shared/livePreview/protocol';

describe('LivePreviewFrame bridge trust checks', () => {
  const bridgeReady = {
    source: MESSAGE_SOURCE_BRIDGE,
    version: '0.1.0',
    type: 'vg:ready',
    url: 'http://localhost:5173/',
  };

  it('derives the expected origin from the dev server URL', () => {
    expect(getLivePreviewOrigin('http://localhost:5173/app')).toBe('http://localhost:5173');
    expect(getLivePreviewOrigin('not a url')).toBeNull();
  });

  it('accepts bridge messages only from the current iframe window and origin', () => {
    const iframeWindow = {};

    expect(isTrustedLivePreviewBridgeEvent({
      data: bridgeReady,
      source: iframeWindow as MessageEventSource,
      origin: 'http://localhost:5173',
    }, iframeWindow, 'http://localhost:5173')).toBe(true);

    expect(isTrustedLivePreviewBridgeEvent({
      data: bridgeReady,
      source: {},
      origin: 'http://localhost:5173',
    }, iframeWindow, 'http://localhost:5173')).toBe(false);

    expect(isTrustedLivePreviewBridgeEvent({
      data: bridgeReady,
      source: iframeWindow as MessageEventSource,
      origin: 'http://evil.test',
    }, iframeWindow, 'http://localhost:5173')).toBe(false);

    expect(isTrustedLivePreviewBridgeEvent({
      data: { source: 'other', type: 'vg:ready' },
      source: iframeWindow as MessageEventSource,
      origin: 'http://localhost:5173',
    }, iframeWindow, 'http://localhost:5173')).toBe(false);
  });
});
