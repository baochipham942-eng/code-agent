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

/** 飞入动效参数（随 image_ready 下发，便于前端 reduced-motion 与 chip 同步） */
interface AppshotMotionInfo {
  durationMs: number;
  /** 飞入抵达落点（handoff 事件发出）距动画开始的毫秒数 */
  handoffAtMs: number;
}

/**
 * `appshots:image_ready` 载荷：PNG 落盘 + 快门后即发（与飞入同时），
 * 文本（AX/OCR）随后经 `appshots:text_ready` 补齐。
 */
export interface AppshotImageReady {
  requestId: string;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  screenshotPath: string;
  /** 可选：若原生已读 dataURL 可带；默认仍前端读 path */
  screenshotDataUrl?: string;
  windowFrame: AppshotWindowFrame;
  capturedAtMs: number;
  /** 发送目标会话：Rust 捕获时直读 config.json 带入（前端绑定会话不再走设置 IPC） */
  targetSession?: 'current' | 'new';
  motion?: AppshotMotionInfo;
}

/** `appshots:text_ready` 载荷：AX/OCR 完成后的文本 enrichment（可能先于或晚于 handoff） */
export interface AppshotTextReady {
  requestId: string;
  axText?: string | null;
  textSource: AppshotTextSource;
}

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
  /** text_ready 已到达（无论是否识别到文字）：chip 用它在到达前显示「识别中…」 */
  textReady?: boolean;
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
 * 即使没有 axText 也输出（带 app/窗口名/捕获时间与「用户主动截取的上下文」语义，
 * 截图自身仍会作为图片附件发送，供视觉模型看）。
 */
export function buildAppshotXml(capture: AppshotCapture): string {
  const text = (capture.axText ?? '').trim();
  const header = `${capture.appName}${capture.windowTitle ? ` · ${capture.windowTitle}` : ''}`;
  const app = escapeXmlAttr(capture.bundleId ?? '');
  const name = escapeXmlAttr(capture.appName);
  const captured = escapeXmlAttr(new Date(capture.capturedAtMs).toISOString());
  const context = `用户刚刚用快捷键主动截取了「${header}」这个窗口的屏幕，作为本条消息的上下文（通常是用户当前关注的焦点）。`;
  if (!text) {
    return `<appshot app="${app}" name="${name}" captured="${captured}">\n${context}\n</appshot>`;
  }
  const clipped =
    text.length > APPSHOT_TEXT_MAX ? `${text.slice(0, APPSHOT_TEXT_MAX)}\n…(truncated)` : text;
  return `<appshot app="${app}" name="${name}" captured="${captured}">\n${context}\n\n# Appshot of ${header}\n\n${clipped}\n</appshot>`;
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
    // 磁盘路径兜底：媒体管线对大图剥离内联数据后，气泡仍可从本地文件渲染
    // （getRenderableMediaSrc 优先走 asset.path → resolveFileUrl）。
    path: capture.screenshotPath,
    // 气泡渲染专用卡片所需的 app 元数据（随消息 JSON 持久化/回放）
    appshot: {
      appName: capture.appName || null,
      windowTitle: capture.windowTitle ?? null,
      bundleId: capture.bundleId ?? null,
      axText: capture.axText ?? null,
      textSource: capture.textSource,
    },
  };
}
