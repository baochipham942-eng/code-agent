import { describe, expect, it, vi } from 'vitest';
import { refreshBrowserTabFavicon } from '../../../../../src/host/services/infra/browser/tabHistoryMetadata';
import type { BrowserTab } from '../../../../../src/host/services/infra/browser/types';

function fakeTab(overrides: {
  url: string;
  evaluateResult?: string | null;
  evaluateThrow?: boolean;
}): BrowserTab {
  return {
    id: 'tab-1',
    url: overrides.url,
    title: 't',
    page: {
      url: () => overrides.url,
      evaluate: overrides.evaluateThrow
        ? vi.fn(async () => { throw new Error('boom'); })
        : vi.fn(async () => overrides.evaluateResult ?? null),
    } as unknown as BrowserTab['page'],
  };
}

describe('refreshBrowserTabFavicon', () => {
  it('优先使用 document link icon', async () => {
    const tab = fakeTab({
      url: 'https://www.baidu.com/',
      evaluateResult: 'https://www.baidu.com/favicon.ico',
    });
    await refreshBrowserTabFavicon(tab);
    expect(tab.faviconUrl).toBe('https://www.baidu.com/favicon.ico');
  });

  it('document 无 link 时兜底 origin/favicon.ico', async () => {
    const tab = fakeTab({
      url: 'https://example.com/path',
      evaluateResult: null,
    });
    await refreshBrowserTabFavicon(tab);
    expect(tab.faviconUrl).toBe('https://example.com/favicon.ico');
  });

  it('evaluate 失败仍兜底 origin；非 http 页为 null', async () => {
    const tab = fakeTab({
      url: 'https://example.com/',
      evaluateThrow: true,
    });
    await refreshBrowserTabFavicon(tab);
    expect(tab.faviconUrl).toBe('https://example.com/favicon.ico');

    const about = fakeTab({ url: 'about:blank', evaluateResult: null });
    await refreshBrowserTabFavicon(about);
    expect(about.faviconUrl).toBeNull();
  });
});
