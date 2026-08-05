import type { BrowserTab } from './types';

/**
 * 用 Chromium CDP `Page.getNavigationHistory` 刷新 canGoBack / canGoForward。
 * 失败时保守置 false（工具条后退/前进置灰），不阻断元数据刷新主路径。
 */
export async function refreshBrowserTabHistoryFlags(tab: BrowserTab): Promise<void> {
  try {
    const session = await tab.page.context().newCDPSession(tab.page);
    try {
      const history = await session.send('Page.getNavigationHistory') as {
        currentIndex?: number;
        entries?: unknown[];
      };
      const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
      const entries = Array.isArray(history.entries) ? history.entries : [];
      tab.canGoBack = index > 0;
      tab.canGoForward = index < entries.length - 1;
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    tab.canGoBack = false;
    tab.canGoForward = false;
  }
}

/**
 * 解析当前页 favicon：优先 document link[rel*=icon]，再兜底 origin/favicon.ico。
 * 拿不到则置 null（renderer 回落 Globe 图标）。
 */
export async function refreshBrowserTabFavicon(tab: BrowserTab): Promise<void> {
  const pageUrl = tab.page.url();
  let originFallback: string | null = null;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      originFallback = `${parsed.origin}/favicon.ico`;
    }
  } catch {
    originFallback = null;
  }

  try {
    const href = await tab.page.evaluate(() => {
      const pick = (rel: string): string | null => {
        const el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
        return el?.href || null;
      };
      return pick('icon')
        || pick('shortcut icon')
        || document.querySelector<HTMLLinkElement>('link[rel*="icon"]')?.href
        || null;
    }).catch(() => null);
    if (typeof href === 'string' && href.trim()) {
      try {
        const absolute = new URL(href, pageUrl).href;
        if (absolute.startsWith('http://') || absolute.startsWith('https://') || absolute.startsWith('data:')) {
          tab.faviconUrl = absolute;
          return;
        }
      } catch {
        // fall through
      }
    }
  } catch {
    // fall through to origin fallback
  }

  tab.faviconUrl = originFallback;
}

/** URL/title + 历史可用态 + favicon，供 BrowserService 导航后回写。 */
export async function refreshBrowserTabMetadata(tab: BrowserTab): Promise<void> {
  tab.url = tab.page.url();
  tab.title = await tab.page.title().catch(() => tab.title);
  await refreshBrowserTabHistoryFlags(tab);
  await refreshBrowserTabFavicon(tab);
}
