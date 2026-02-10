// ============================================================================
// Background Service Worker - 管理与本地 Code Agent 的通信
// ============================================================================

const DEFAULT_API_URL = 'http://localhost:8080';
const API_KEY_STORAGE_KEY = 'codeAgentApiKey';
const API_URL_STORAGE_KEY = 'codeAgentApiUrl';
const AUTO_CAPTURE_KEY = 'codeAgentAutoCapture';

// 已采集 URL 去重（Service Worker 生命周期内）
const capturedUrls = new Set();

// 缓存连接状态（避免每个页面都检查）
let connectionOk = null;
let lastConnectionCheck = 0;

// 跳过的 URL 前缀
const SKIP_PREFIXES = [
  'chrome://', 'chrome-extension://', 'about:', 'edge://',
  'brave://', 'devtools://', 'file://', 'data:', 'blob:',
  'chrome-search://', 'new-tab-page',
];

/**
 * 获取 API 配置
 */
async function getApiConfig() {
  const result = await chrome.storage.local.get([API_KEY_STORAGE_KEY, API_URL_STORAGE_KEY]);
  return {
    apiUrl: result[API_URL_STORAGE_KEY] || DEFAULT_API_URL,
    apiKey: result[API_KEY_STORAGE_KEY] || '',
  };
}

/**
 * 检查是否开启了自动采集
 */
async function isAutoCapture() {
  const result = await chrome.storage.local.get(AUTO_CAPTURE_KEY);
  return result[AUTO_CAPTURE_KEY] !== false; // 默认开启
}

/**
 * 判断 URL 是否应该跳过
 */
function shouldSkipUrl(url) {
  if (!url) return true;
  if (SKIP_PREFIXES.some(p => url.startsWith(p))) return true;
  return false;
}

/**
 * 检查连接（带缓存，30 秒内不重复检查）
 */
async function checkConnection(force = false) {
  const now = Date.now();
  if (!force && connectionOk !== null && now - lastConnectionCheck < 30000) {
    return connectionOk;
  }
  const { apiUrl } = await getApiConfig();
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    connectionOk = response.ok;
  } catch {
    connectionOk = false;
  }
  lastConnectionCheck = now;
  return connectionOk;
}

/**
 * 提取页面内容 - 先尝试 content script，再尝试 executeScript
 */
async function extractFromTab(tabId) {
  // 方式1: 通过 content script 消息（如果已注入）
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'extractContent' });
    if (result?.success && result.data?.content?.length >= 100) {
      return result.data;
    }
  } catch {
    // content script 未注入，尝试方式2
  }

  // 方式2: 通过 chrome.scripting.executeScript 直接注入
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function extractContent() {
          const cloned = document.cloneNode(true);
          ['script','style','nav','header','footer','iframe','noscript','.ad','.ads','.advertisement','[role="navigation"]','[role="banner"]','[role="contentinfo"]'].forEach(sel => {
            cloned.querySelectorAll(sel).forEach(el => el.remove());
          });
          let mainEl = null;
          for (const sel of ['article','main','[role="main"]','.post-content','.article-content','.entry-content']) {
            mainEl = cloned.querySelector(sel);
            if (mainEl) break;
          }
          return htmlToText(mainEl || cloned.body || cloned.documentElement);
        }
        function htmlToText(el) {
          if (!el) return '';
          let text = '';
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const t = node.textContent.trim();
              if (t) text += t + ' ';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const tag = node.tagName.toLowerCase();
              if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
                text += '\n' + '#'.repeat(parseInt(tag[1])) + ' ' + node.textContent.trim() + '\n\n';
              } else if (tag === 'p') {
                text += node.textContent.trim() + '\n\n';
              } else if (tag === 'li') {
                text += '- ' + node.textContent.trim() + '\n';
              } else if (['pre','code'].includes(tag)) {
                text += '\n```\n' + node.textContent.trim() + '\n```\n\n';
              } else if (tag === 'a') {
                const href = node.getAttribute('href');
                const lt = node.textContent.trim();
                text += href && lt ? `[${lt}](${href}) ` : lt + ' ';
              } else {
                text += htmlToText(node);
              }
            }
          }
          return text.replace(/\n{3,}/g, '\n\n').trim();
        }
        function getMetadata() {
          const meta = {};
          const a = document.querySelector('meta[name="author"]') || document.querySelector('meta[property="article:author"]');
          if (a) meta.author = a.getAttribute('content');
          const d = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
          if (d) meta.description = d.getAttribute('content');
          return meta;
        }
        const content = extractContent();
        if (content.length < 100) return null;
        return { url: window.location.href, title: document.title, content, metadata: getMetadata() };
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

/**
 * 发送采集内容到本地 Code Agent
 */
async function sendCapture(data) {
  const { apiUrl } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

/**
 * 更新 badge 数量
 */
function updateBadge() {
  const count = capturedUrls.size;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#06b6d4' });
}

/**
 * 自动采集：页面加载完成时触发
 */
async function autoCapture(tabId, url) {
  // 前置检查（快速返回，不做网络请求）
  if (shouldSkipUrl(url)) return;
  if (capturedUrls.has(url)) return;

  const autoOn = await isAutoCapture();
  if (!autoOn) return;

  const connected = await checkConnection();
  if (!connected) return;

  try {
    const extraction = await extractFromTab(tabId);
    if (!extraction) return;

    await sendCapture({
      url: extraction.url,
      title: extraction.title,
      content: extraction.content,
      source: 'browser_extension',
      metadata: extraction.metadata,
    });

    capturedUrls.add(url);
    updateBadge();
  } catch (error) {
    console.error('[CodeAgent] Auto-capture failed:', url, error.message);
    // 连接失败时重置缓存，下次重新检查
    if (error.message?.includes('fetch')) {
      connectionOk = null;
    }
  }
}

// ========== 事件监听 ==========

// 监听页面加载完成 — 不用 setTimeout，直接触发
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    autoCapture(tabId, tab.url);
  }
});

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'capture') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('无法获取当前标签页');
        const extraction = await extractFromTab(tab.id);
        if (!extraction) throw new Error('页面内容太短，无法采集');
        const result = await sendCapture({
          url: extraction.url,
          title: extraction.title,
          content: extraction.content,
          source: 'browser_extension',
          metadata: extraction.metadata,
        });
        capturedUrls.add(extraction.url);
        updateBadge();
        sendResponse({ success: true, data: result });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'checkConnection') {
    checkConnection(true)
      .then(connected => sendResponse({ connected }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message.type === 'getConfig') {
    (async () => {
      const config = await getApiConfig();
      const autoCapture = await isAutoCapture();
      sendResponse({ ...config, autoCapture });
    })();
    return true;
  }

  if (message.type === 'getStats') {
    sendResponse({ capturedCount: capturedUrls.size });
    return true;
  }
});

// Service Worker 启动时打印日志
console.log('[CodeAgent] Service worker started');
