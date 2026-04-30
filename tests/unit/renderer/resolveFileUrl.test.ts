import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasNativeBridge: vi.fn(),
}));

vi.mock('../../../src/renderer/api/transport', () => ({
  hasNativeBridge: mocks.hasNativeBridge,
}));

import { resolveFileUrl } from '../../../src/renderer/utils/resolveFileUrl';

function stubWindow(protocol: string, token?: string) {
  vi.stubGlobal('window', {
    location: { protocol },
    __CODE_AGENT_TOKEN__: token,
  });
}

describe('resolveFileUrl', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.hasNativeBridge.mockReset();
  });

  it('adds the browser auth token when resolving workspace files in web mode', () => {
    mocks.hasNativeBridge.mockReturnValue(false);
    stubWindow('http:', 'test-token');

    const resolved = resolveFileUrl('/tmp/Design Deck/slide 1.jpg');
    const params = new URLSearchParams(resolved.split('?')[1]);

    expect(resolved.startsWith('/api/workspace/file?')).toBe(true);
    expect(params.get('path')).toBe('/tmp/Design Deck/slide 1.jpg');
    expect(params.get('token')).toBe('test-token');
  });

  it('omits the token query param when none is available', () => {
    mocks.hasNativeBridge.mockReturnValue(false);
    stubWindow('http:');

    const resolved = resolveFileUrl('/tmp/slide.jpg');
    const params = new URLSearchParams(resolved.split('?')[1]);

    expect(params.get('path')).toBe('/tmp/slide.jpg');
    expect(params.has('token')).toBe(false);
  });

  it('keeps native desktop file paths as file URLs', () => {
    mocks.hasNativeBridge.mockReturnValue(true);
    stubWindow('tauri:', 'test-token');

    expect(resolveFileUrl('/tmp/slide.jpg')).toBe('file:///tmp/slide.jpg');
  });
});
