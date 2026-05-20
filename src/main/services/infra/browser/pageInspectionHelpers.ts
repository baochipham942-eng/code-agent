import type {
  BrowserTab,
  ElementInfo,
  PageContent,
} from './types';

export async function getBrowserPageContent(tab: BrowserTab): Promise<PageContent> {
  const [text, links] = await Promise.all([
    tab.page.innerText('body').catch(() => ''),
    tab.page.$$eval('a[href]', (anchors) =>
      anchors.slice(0, 50).map((a) => ({
        text: a.textContent?.trim() || '',
        href: (a as HTMLAnchorElement).href,
      }))
    ).catch(() => []),
  ]);

  return {
    url: tab.page.url(),
    title: await tab.page.title(),
    text: text.substring(0, 10000),
    links,
  };
}

export async function getBrowserPageHtml(tab: BrowserTab): Promise<string> {
  return await tab.page.content();
}

export async function findBrowserElements(
  tab: BrowserTab,
  selector: string,
): Promise<ElementInfo[]> {
  return await tab.page.$$eval(selector, (elements) =>
    elements.slice(0, 20).map((el) => ({
      selector: '',
      text: el.textContent?.trim().substring(0, 100) || '',
      tagName: el.tagName.toLowerCase(),
      attributes: Object.fromEntries(
        Array.from(el.attributes).map((attr) => [attr.name, attr.value])
      ),
      rect: el.getBoundingClientRect(),
    }))
  );
}

export async function findBrowserElementByText(
  tab: BrowserTab,
  text: string,
): Promise<ElementInfo | null> {
  const element = await tab.page.$(`text=${text}`);
  if (!element) return null;

  return await element.evaluate((el) => ({
    selector: '',
    text: el.textContent?.trim() || '',
    tagName: el.tagName.toLowerCase(),
    attributes: Object.fromEntries(
      Array.from(el.attributes).map((attr) => [attr.name, attr.value])
    ),
    rect: el.getBoundingClientRect(),
  }));
}
