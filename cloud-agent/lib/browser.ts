// ============================================================================
// Browser Automation - 使用 Playwright 执行浏览器任务
// ============================================================================

import { chromium, type Browser, type Page } from 'playwright-core';

interface CloudTaskRequest {
  id: string;
  type: string;
  payload: {
    action?: string;
    url?: string;
    selector?: string;
    fields?: Array<{ selector: string; value: string }>;
    [key: string]: unknown;
  };
}

interface CloudTaskResponse {
  id: string;
  status: 'success' | 'error';
  result?: unknown;
  error?: string;
  screenshots?: string[];
}

// Vercel 上使用 @vercel/playwright 或者 browserless 服务
const BROWSER_WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT;

async function getBrowser(): Promise<Browser> {
  if (BROWSER_WS_ENDPOINT) {
    // 连接到远程浏览器服务（如 browserless.io）
    return chromium.connect(BROWSER_WS_ENDPOINT);
  }

  // 本地开发模式
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

export async function executeBrowserTask(
  request: CloudTaskRequest
): Promise<CloudTaskResponse> {
  const { id, payload } = request;
  const { action, url } = payload;

  if (!action) {
    return {
      id,
      status: 'error',
      error: 'Missing action in payload',
    };
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // 设置默认超时
    page.setDefaultTimeout(30000);

    let result: unknown;
    const screenshots: string[] = [];

    switch (action) {
      case 'screenshot': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for screenshot' };
        }
        await page.goto(url, { waitUntil: 'networkidle' });
        const screenshot = await page.screenshot({ type: 'png', fullPage: true });
        screenshots.push(screenshot.toString('base64'));
        result = { url, captured: true };
        break;
      }

      case 'scrape': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for scrape' };
        }
        await page.goto(url, { waitUntil: 'networkidle' });

        const selector = payload.selector as string | undefined;
        if (selector) {
          result = await page.locator(selector).allTextContents();
        } else {
          // 获取整个页面文本
          result = await page.locator('body').innerText();
        }
        break;
      }

      case 'fillForm': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for fillForm' };
        }
        const fields = payload.fields as Array<{ selector: string; value: string }>;
        if (!fields || !Array.isArray(fields)) {
          return { id, status: 'error', error: 'Missing fields for fillForm' };
        }

        await page.goto(url, { waitUntil: 'networkidle' });

        for (const field of fields) {
          await page.locator(field.selector).fill(field.value);
        }

        result = { filled: fields.length };
        break;
      }

      case 'click': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for click' };
        }
        const clickSelector = payload.selector as string;
        if (!clickSelector) {
          return { id, status: 'error', error: 'Missing selector for click' };
        }

        await page.goto(url, { waitUntil: 'networkidle' });
        await page.locator(clickSelector).click();

        // 等待页面稳定
        await page.waitForLoadState('networkidle');

        result = { clicked: clickSelector };
        break;
      }

      case 'evaluate': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for evaluate' };
        }
        const script = payload.script as string;
        if (!script) {
          return { id, status: 'error', error: 'Missing script for evaluate' };
        }

        await page.goto(url, { waitUntil: 'networkidle' });
        result = await page.evaluate(script);
        break;
      }

      case 'pdf': {
        if (!url) {
          return { id, status: 'error', error: 'Missing url for pdf' };
        }
        await page.goto(url, { waitUntil: 'networkidle' });
        const pdf = await page.pdf({ format: 'A4' });
        result = { pdf: pdf.toString('base64') };
        break;
      }

      default:
        return {
          id,
          status: 'error',
          error: `Unknown browser action: ${action}`,
        };
    }

    return {
      id,
      status: 'success',
      result,
      screenshots: screenshots.length > 0 ? screenshots : undefined,
    };
  } catch (error: any) {
    console.error('Browser task error:', error);
    return {
      id,
      status: 'error',
      error: error.message || 'Browser task failed',
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
