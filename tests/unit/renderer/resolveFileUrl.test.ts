import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasNativeBridge: vi.fn(),
}));

vi.mock('../../../src/renderer/api/transport', () => ({
  hasNativeBridge: mocks.hasNativeBridge,
}));

import { resolveFileUrl, resolveScreenshotUrl } from '../../../src/renderer/utils/resolveFileUrl';

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

  it('routes browser screenshots under the config dir to /api/screenshot in web mode', () => {
    mocks.hasNativeBridge.mockReturnValue(false);
    stubWindow('http:', 'test-token');

    const resolved = resolveFileUrl('/Users/linchen/.code-agent/screenshots/screenshot_123.png');
    const params = new URLSearchParams(resolved.split('?')[1]);

    expect(resolved.startsWith('/api/screenshot?')).toBe(true);
    expect(params.get('path')).toBe('/Users/linchen/.code-agent/screenshots/screenshot_123.png');
    // /api/screenshot 不再豁免鉴权，URL 必须带 token
    expect(params.get('token')).toBe('test-token');
  });

  it('routes dev-channel config dir (.code-agent-dev) images to /api/screenshot in web mode', () => {
    mocks.hasNativeBridge.mockReturnValue(false);
    stubWindow('http:', 'test-token');

    const cachePath = '/Users/linchen/.code-agent-dev/cache/presentation-page-previews/rev123/pages/deck-01.jpg';
    const resolved = resolveFileUrl(cachePath);
    const params = new URLSearchParams(resolved.split('?')[1]);

    expect(resolved.startsWith('/api/screenshot?')).toBe(true);
    expect(params.get('path')).toBe(cachePath);
    expect(params.get('token')).toBe('test-token');
  });

  it('builds authed screenshot URLs via resolveScreenshotUrl', () => {
    stubWindow('http:', 'test-token');

    const url = resolveScreenshotUrl('/Users/linchen/.code-agent/native-desktop/screenshots/a.png');
    const params = new URLSearchParams(url.split('?')[1]);

    expect(url.startsWith('/api/screenshot?')).toBe(true);
    expect(params.get('token')).toBe('test-token');
  });

  it('routes config-dir screenshots using Windows backslash separators to /api/screenshot', () => {
    mocks.hasNativeBridge.mockReturnValue(false);
    stubWindow('http:');

    const winPath = 'C:\\Users\\lin\\.code-agent\\screenshots\\screenshot_123.png';
    const resolved = resolveFileUrl(winPath);
    const params = new URLSearchParams(resolved.split('?')[1]);

    expect(resolved.startsWith('/api/screenshot?')).toBe(true);
    expect(params.get('path')).toBe(winPath);
  });

  it('keeps native desktop file paths as file URLs', () => {
    mocks.hasNativeBridge.mockReturnValue(true);
    stubWindow('tauri:', 'test-token');

    expect(resolveFileUrl('/tmp/slide.jpg')).toBe('file:///tmp/slide.jpg');
  });
});
