import type {
  BrowserTab,
  ElementInfo,
  PageContent,
} from './types';
import { pageHasLoginForm } from '../../../../shared/utils/browserLoginWall';

export async function getBrowserPageContent(tab: BrowserTab): Promise<PageContent> {
  const [text, links, passwordInputPresent, loginFormPresent] = await Promise.all([
    tab.page.innerText('body').catch(() => ''),
    tab.page.$$eval('a[href]', (anchors) =>
      anchors.slice(0, 50).map((a) => ({
        text: a.textContent?.trim() || '',
        href: (a as HTMLAnchorElement).href,
      }))
    ).catch(() => []),
    tab.page.locator('input[type="password"], input[autocomplete*="password" i]').count()
      .then((count) => count > 0)
      .catch(() => false),
    // 任意 <form> 不算登录证据（JD/淘宝式首页搜索表单会误停无人值守运行）：
    // 页内只做属性序列化，分类走 shared 的严格 isLoginFormEvidence。
    tab.page.$$eval('form', (forms) => forms.map((form) => ({
      role: form.getAttribute('role'),
      action: form.getAttribute('action'),
      inputs: Array.from(form.querySelectorAll('input')).map((input) => ({
        type: input.type,
        autocomplete: input.getAttribute('autocomplete'),
      })),
      submitTexts: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((el) => [
        el.textContent ?? '',
        el.getAttribute('value') ?? '',
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
      ].join(' ')),
    })))
      .then(pageHasLoginForm)
      .catch(() => false),
  ]);

  return {
    url: tab.page.url(),
    title: await tab.page.title(),
    text: text.substring(0, 10000),
    links,
    passwordInputPresent,
    loginFormPresent,
  };
}

export async function getBrowserPageHtml(tab: BrowserTab): Promise<string> {
  return await tab.page.content();
}

export async function getBrowserElementBoundingBox(
  tab: BrowserTab,
  selector: string,
): Promise<ElementInfo['rect'] | null> {
  const box = await tab.page.locator(selector).first().boundingBox().catch(() => null);
  return box
    ? {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
    : null;
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
