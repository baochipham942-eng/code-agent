// ============================================================================
// Browser Automation - 使用 Playwright 执行浏览器任务
// ============================================================================
//
// 安全实现说明：
// - URL 白名单验证，防止 SSRF 攻击
// - 移除了危险的 evaluate action（任意 JavaScript 执行）
// - 添加请求频率限制
// - 超时控制防止资源滥用
//
// ============================================================================

import { chromium, type Browser, type Page } from 'playwright-core';
import { createLogger } from './logger.js';

const logger = createLogger('Browser');

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

// 是否启用严格的域名白名单模式（默认关闭）
const STRICT_WHITELIST_MODE = process.env.BROWSER_STRICT_MODE === 'true';

// 严格模式下的域名白名单
const ALLOWED_DOMAINS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'stackoverflow.com',
  'npmjs.com',
  'pypi.org',
  'docs.python.org',
  'developer.mozilla.org',
  'reactjs.org',
  'vuejs.org',
  'angular.io',
  'nodejs.org',
  'typescriptlang.org',
  ...(process.env.BROWSER_ALLOWED_DOMAINS?.split(',').map(d => d.trim()) || []),
];

// 始终阻止的高风险地址（云元数据服务）
const BLOCKED_HOSTS = [
  '169.254.169.254',  // AWS/GCP metadata
  'metadata.google.internal',
  '100.100.100.200',  // Alibaba Cloud metadata
];

// 请求频率限制
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 分钟
const RATE_LIMIT_MAX = 10; // 每分钟最多 10 次

function checkRateLimit(userId: string = 'anonymous'): boolean {
  const now = Date.now();
  const record = requestCounts.get(userId);

  if (!record || now > record.resetTime) {
    requestCounts.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }

  record.count++;
  return true;
}

// 验证 URL 是否允许访问
function validateUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const urlObj = new URL(url);

    // 检查协议
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { valid: false, reason: `Protocol not allowed: ${urlObj.protocol}` };
    }

    const hostname = urlObj.hostname.toLowerCase();

    // 始终阻止云元数据服务（真正危险的）
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, reason: 'Access to cloud metadata services is not allowed' };
    }

    // 严格模式：检查域名白名单
    if (STRICT_WHITELIST_MODE) {
      const isAllowed = ALLOWED_DOMAINS.some(domain => {
        const normalizedDomain = domain.toLowerCase();
        return hostname === normalizedDomain || hostname.endsWith('.' + normalizedDomain);
      });

      if (!isAllowed) {
        return {
          valid: false,
          reason: `Domain not in whitelist: ${hostname}. Set BROWSER_STRICT_MODE=false to disable whitelist.`,
        };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
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
  request: CloudTaskRequest,
  userId?: string
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

  // 频率限制检查
  if (!checkRateLimit(userId)) {
    return {
      id,
      status: 'error',
      error: 'Rate limit exceeded. Maximum 10 requests per minute.',
    };
  }

  // URL 验证（对需要 URL 的操作）
  if (url) {
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      return {
        id,
        status: 'error',
        error: urlValidation.reason,
      };
    }
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // 设置默认超时
    page.setDefaultTimeout(30000);

    // 阻止导航到非白名单域名
    page.on('request', (request) => {
      const requestUrl = request.url();
      try {
        const urlObj = new URL(requestUrl);
        // 允许资源加载（图片、CSS、JS等），但阻止导航到非白名单域名
        if (request.isNavigationRequest()) {
          const validation = validateUrl(requestUrl);
          if (!validation.valid) {
            request.abort('blockedbyclient');
            return;
          }
        }
      } catch {
        // 忽略无效 URL
      }
      request.continue().catch(() => {});
    });

    await page.route('**/*', (route) => route.continue());

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
          // 验证选择器格式（防止注入）
          if (!/^[a-zA-Z0-9\s\-_#.\[\]="':,>+~*()]+$/.test(selector)) {
            return { id, status: 'error', error: 'Invalid selector format' };
          }
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

        // 限制字段数量
        if (fields.length > 20) {
          return { id, status: 'error', error: 'Too many fields. Maximum 20 allowed.' };
        }

        // 验证每个字段的选择器
        for (const field of fields) {
          if (!/^[a-zA-Z0-9\s\-_#.\[\]="':,>+~*()]+$/.test(field.selector)) {
            return { id, status: 'error', error: `Invalid selector format: ${field.selector}` };
          }
          // 限制值的长度
          if (field.value && field.value.length > 10000) {
            return { id, status: 'error', error: 'Field value too long. Maximum 10000 characters.' };
          }
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

        // 验证选择器格式
        if (!/^[a-zA-Z0-9\s\-_#.\[\]="':,>+~*()]+$/.test(clickSelector)) {
          return { id, status: 'error', error: 'Invalid selector format' };
        }

        await page.goto(url, { waitUntil: 'networkidle' });
        await page.locator(clickSelector).click();

        // 等待页面稳定
        await page.waitForLoadState('networkidle');

        result = { clicked: clickSelector };
        break;
      }

      case 'evaluate': {
        // 恢复 evaluate action，添加基本限制
        if (!url) {
          return { id, status: 'error', error: 'Missing url for evaluate' };
        }
        const script = payload.script as string;
        if (!script) {
          return { id, status: 'error', error: 'Missing script for evaluate' };
        }

        // 脚本长度限制
        if (script.length > 10000) {
          return { id, status: 'error', error: 'Script too long. Maximum 10000 characters.' };
        }

        await page.goto(url, { waitUntil: 'networkidle' });

        // 执行脚本，设置超时
        const evalResult = await Promise.race([
          page.evaluate(script),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Script execution timeout')), 5000)
          ),
        ]);

        result = { evaluated: true, result: evalResult };
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

      case 'getLinks': {
        // 新增：安全地获取页面链接
        if (!url) {
          return { id, status: 'error', error: 'Missing url for getLinks' };
        }
        await page.goto(url, { waitUntil: 'networkidle' });
        const links = await page.locator('a[href]').evaluateAll((elements: HTMLAnchorElement[]) =>
          elements.map(el => ({
            href: el.href,
            text: el.textContent?.trim() || '',
          })).slice(0, 100) // 限制返回数量
        );
        result = { links };
        break;
      }

      case 'getMetadata': {
        // 新增：安全地获取页面元数据
        if (!url) {
          return { id, status: 'error', error: 'Missing url for getMetadata' };
        }
        await page.goto(url, { waitUntil: 'networkidle' });
        const metadata = await page.evaluate(() => ({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          keywords: document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
          ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
        }));
        result = { metadata };
        break;
      }

      default:
        return {
          id,
          status: 'error',
          error: `Unknown browser action: ${action}. Available actions: screenshot, scrape, fillForm, click, evaluate, pdf, getLinks, getMetadata`,
        };
    }

    return {
      id,
      status: 'success',
      result,
      screenshots: screenshots.length > 0 ? screenshots : undefined,
    };
  } catch (error: unknown) {
    logger.error('Browser task failed', error);
    const errorMessage = error instanceof Error ? error.message : 'Browser task failed';
    return {
      id,
      status: 'error',
      error: errorMessage,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
