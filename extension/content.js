// ============================================================================
// Content Script - 网页内容提取
// ============================================================================

/**
 * 提取页面正文（简化版 Readability）
 */
function extractContent() {
  // 移除不需要的元素
  const cloned = document.cloneNode(true);
  const removeSelectors = [
    'script', 'style', 'nav', 'header', 'footer',
    'iframe', 'noscript', '.ad', '.ads', '.advertisement',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ];
  removeSelectors.forEach(sel => {
    cloned.querySelectorAll(sel).forEach(el => el.remove());
  });

  // 尝试找主内容区域
  const mainSelectors = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content'];
  let mainEl = null;
  for (const sel of mainSelectors) {
    mainEl = cloned.querySelector(sel);
    if (mainEl) break;
  }

  const contentEl = mainEl || cloned.body;
  if (!contentEl) return '';

  // 转换为 Markdown-like 纯文本
  return htmlToText(contentEl);
}

/**
 * HTML → 纯文本（保留基本结构）
 */
function htmlToText(el) {
  let text = '';

  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const trimmed = node.textContent.trim();
      if (trimmed) text += trimmed + ' ';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();

      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const level = parseInt(tag[1]);
        text += '\n' + '#'.repeat(level) + ' ' + node.textContent.trim() + '\n\n';
      } else if (tag === 'p') {
        text += node.textContent.trim() + '\n\n';
      } else if (tag === 'li') {
        text += '- ' + node.textContent.trim() + '\n';
      } else if (tag === 'br') {
        text += '\n';
      } else if (['pre', 'code'].includes(tag)) {
        text += '\n```\n' + node.textContent.trim() + '\n```\n\n';
      } else if (['div', 'section'].includes(tag)) {
        text += htmlToText(node);
      } else if (tag === 'a') {
        const href = node.getAttribute('href');
        const linkText = node.textContent.trim();
        if (href && linkText) {
          text += `[${linkText}](${href}) `;
        } else {
          text += linkText + ' ';
        }
      } else if (tag === 'img') {
        const alt = node.getAttribute('alt');
        if (alt) text += `[图片: ${alt}] `;
      } else {
        text += htmlToText(node);
      }
    }
  }

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 获取页面元数据
 */
function getMetadata() {
  const meta = {};

  // 作者
  const authorMeta = document.querySelector('meta[name="author"]') || document.querySelector('meta[property="article:author"]');
  if (authorMeta) meta.author = authorMeta.getAttribute('content');

  // 发布日期
  const dateMeta = document.querySelector('meta[property="article:published_time"]') || document.querySelector('meta[name="date"]');
  if (dateMeta) meta.publishDate = dateMeta.getAttribute('content');

  // 描述
  const descMeta = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
  if (descMeta) meta.description = descMeta.getAttribute('content');

  // 关键词
  const keywordsMeta = document.querySelector('meta[name="keywords"]');
  if (keywordsMeta) meta.keywords = keywordsMeta.getAttribute('content');

  return meta;
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'extractContent') {
    try {
      const content = extractContent();
      const metadata = getMetadata();
      sendResponse({
        success: true,
        data: {
          url: window.location.href,
          title: document.title,
          content,
          metadata,
        },
      });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
});
