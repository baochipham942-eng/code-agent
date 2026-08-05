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

/** URL/title + 历史可用态，供 BrowserService 导航后回写。 */
export async function refreshBrowserTabMetadata(tab: BrowserTab): Promise<void> {
  tab.url = tab.page.url();
  tab.title = await tab.page.title().catch(() => tab.title);
  await refreshBrowserTabHistoryFlags(tab);
}
