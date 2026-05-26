// ============================================================================
// Appshots 共享契约
// 与 src-tauri/src/appshots.rs 的 AppshotsCaptureInfo（camelCase 序列化）对应。
// 负责：捕获结果类型 + 隐藏 XML 上下文的构建/剥离 + 截图附件构建。
// ============================================================================

import type { MessageAttachment } from './message';

export interface AppshotWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AppshotTextSource = 'ax' | 'ocr' | 'none';

export interface AppshotCapture {
  requestId: string;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  screenshotPath: string;
  /** 由 appshots_read_image_data_url 按需填充的 base64 dataURL（事件本身不带，保持轻量） */
  screenshotDataUrl?: string;
  /** 窗口可读文本：AX 优先，AX 为空时本地 OCR 兜底 */
  axText?: string | null;
  /** 文本来源，用于 chip 提示用户当前是「图+文」还是「仅图」 */
  textSource: AppshotTextSource;
  /** 窗口在屏幕上的位置（CoreGraphics 坐标），供 Phase 3 飞入动画用 */
  windowFrame: AppshotWindowFrame;
  capturedAtMs: number;
}

const APPSHOT_TEXT_MAX = 4000;

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 把 appshot 的窗口文本打包成隐藏 XML 块，提交时前置到用户消息发给模型。
 * 无 axText 时返回空串（截图自身仍会作为图片附件发送，供视觉模型看）。
 */
export function buildAppshotXml(capture: AppshotCapture): string {
  const text = (capture.axText ?? '').trim();
  if (!text) return '';
  const clipped =
    text.length > APPSHOT_TEXT_MAX ? `${text.slice(0, APPSHOT_TEXT_MAX)}\n…(truncated)` : text;
  const header = `Appshot of ${capture.appName}${capture.windowTitle ? ` · ${capture.windowTitle}` : ''}`;
  const app = escapeXmlAttr(capture.bundleId ?? '');
  const name = escapeXmlAttr(capture.appName);
  return `<appshot app="${app}" name="${name}">\n# ${header}\n\n${clipped}\n</appshot>`;
}

/** 渲染用户消息时剥离 appshot XML 块——用户看干净文本，模型看图+文+元数据。 */
export function stripAppshotBlocks(content: string): string {
  return content
    .replace(/\s*<appshot\b[^>]*>[\s\S]*?<\/appshot>\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把 appshot 截图构建成图片附件（需 screenshotDataUrl 已就绪），随消息发给模型。 */
export function buildAppshotAttachment(capture: AppshotCapture): MessageAttachment | null {
  if (!capture.screenshotDataUrl) return null;
  const approxBytes = Math.round((capture.screenshotDataUrl.length * 3) / 4);
  return {
    id: `appshot-${capture.requestId}`,
    type: 'image',
    category: 'image',
    name: `${capture.appName || 'Appshot'} 截图.png`,
    size: approxBytes,
    mimeType: 'image/png',
    data: capture.screenshotDataUrl,
    thumbnail: capture.screenshotDataUrl,
    path: capture.screenshotPath,
  };
}
