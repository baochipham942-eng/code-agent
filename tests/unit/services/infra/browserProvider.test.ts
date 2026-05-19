import { describe, expect, it } from 'vitest';
import {
  buildSystemChromeCdpArgs,
  normalizeBrowserProviderPreference,
  resolveBrowserProvider,
  resolveCdpEndpointUrl,
} from '../../../../src/main/services/infra/browserProvider';

describe('browser provider resolution', () => {
  it('prefers system Chrome CDP on macOS when the executable exists', () => {
    const result = resolveBrowserProvider({
      env: {},
      platform: 'darwin',
      existsSync: (filePath) => filePath === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });

    expect(result).toMatchObject({
      requestedProvider: 'auto',
      provider: 'system-chrome-cdp',
      missingExecutable: false,
      providerFallbackReason: null,
    });
    expect(result.systemExecutable).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('falls back to Playwright bundled Chromium when auto cannot find Chrome', () => {
    const result = resolveBrowserProvider({
      env: {},
      platform: 'darwin',
      existsSync: () => false,
    });

    expect(result.provider).toBe('playwright-bundled');
    expect(result.missingExecutable).toBe(true);
    expect(result.recommendedAction).toContain('CHROME_PATH');
    expect(result.providerFallbackReason).toContain('falling back');
  });

  it('honors explicit provider and CHROME_PATH aliases', () => {
    expect(normalizeBrowserProviderPreference('playwright')).toBe('playwright-bundled');
    expect(normalizeBrowserProviderPreference('chrome-cdp')).toBe('system-chrome-cdp');

    const result = resolveBrowserProvider({
      env: {
        CHROME_PATH: '/custom/Chrome',
        CODE_AGENT_BROWSER_PROVIDER: 'playwright',
      },
      platform: 'darwin',
      existsSync: () => false,
    });

    expect(result.provider).toBe('playwright-bundled');
    expect(result.systemExecutable).toBe('/custom/Chrome');
    expect(result.providerFallbackReason).toBeNull();
  });

  it('honors CODE_AGENT_SYSTEM_CHROME_PATH as the documented system Chrome override', () => {
    const result = resolveBrowserProvider({
      env: {
        CODE_AGENT_SYSTEM_CHROME_PATH: '/Applications/Chrome For Testing.app/Contents/MacOS/Google Chrome for Testing',
      },
      platform: 'darwin',
      existsSync: (filePath) => filePath.includes('Chrome For Testing'),
    });

    expect(result.provider).toBe('system-chrome-cdp');
    expect(result.systemExecutable).toBe('/Applications/Chrome For Testing.app/Contents/MacOS/Google Chrome for Testing');
    expect(result.missingExecutable).toBe(false);
  });

  it('builds CDP launch args with headless and profile diagnostics', () => {
    const args = buildSystemChromeCdpArgs({
      cdpPort: 9222,
      profileDir: '/tmp/profile',
      headless: true,
      viewport: { width: 1280, height: 720 },
    });

    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--window-size=1280,720');
    expect(args).toContain('--headless=new');
  });

  it('adds managed in-app proxy args for system Chrome without changing provider priority', () => {
    const args = buildSystemChromeCdpArgs({
      cdpPort: 9222,
      profileDir: '/tmp/profile',
      headless: true,
      viewport: { width: 1280, height: 720 },
      proxy: {
        mode: 'http',
        server: 'http://127.0.0.1:7890',
        bypass: ['localhost', '127.0.0.1'],
        source: 'request',
      },
    });

    expect(args).toContain('--proxy-server=http://127.0.0.1:7890');
    expect(args).toContain('--proxy-bypass-list=localhost;127.0.0.1');
  });

  it('prefers the websocket CDP endpoint advertised by Chrome', async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
      { status: 200 },
    );

    await expect(resolveCdpEndpointUrl(9222, fetchImpl)).resolves.toBe('ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('falls back to the HTTP CDP endpoint when Chrome metadata is unavailable', async () => {
    const fetchImpl = async () => new Response('bad request', { status: 400 });

    await expect(resolveCdpEndpointUrl(9222, fetchImpl)).resolves.toBe('http://127.0.0.1:9222');
  });
});
