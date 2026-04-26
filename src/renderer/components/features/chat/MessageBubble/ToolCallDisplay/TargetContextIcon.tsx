// ============================================================================
// TargetContextIcon - 工具调用目标的视觉化图标
// ============================================================================
// 根据 ToolCall.targetContext.{kind, iconHint} 渲染图标，让用户像看 Codex 截图
// 那样一眼认出"在操作哪个 app / 哪个 MCP server / 哪类目标"。
//
// 设计权衡：真正的 macOS app logo 提取需要 NSWorkspace native bridge（在 Tauri
// 端写 Swift/Rust 集成），工时 1 天。先用 emoji + Lucide 图标映射覆盖 70%
// 常见场景（微信、Safari、Chrome 等），后续再上真 logo。
// ============================================================================

import React from 'react';
import {
  Globe,
  Plug,
  FileText,
  Brain,
  Monitor,
  MessageCircle,
} from 'lucide-react';
import type { ToolCallTargetContext } from '@shared/contract';

// macOS bundle id → emoji 映射（人脑一眼识别的 app 图标）
const BUNDLE_ID_EMOJI: Record<string, string> = {
  'com.tencent.xinWeChat': '💬',
  'com.tencent.qq': '🐧',
  'com.apple.Safari': '🧭',
  'com.apple.Mail': '📮',
  'com.apple.Notes': '📝',
  'com.apple.iCal': '📅',
  'com.apple.finder': '📁',
  'com.apple.Terminal': '⌨️',
  'com.apple.Music': '🎵',
  'com.apple.Photos': '🖼',
  'com.apple.Maps': '🗺',
  'com.google.Chrome': '🌐',
  'org.mozilla.firefox': '🦊',
  'com.microsoft.VSCode': '💻',
  'com.microsoft.Outlook': '📧',
  'com.microsoft.teams2': '👥',
  'com.tinyspeck.slackmacgap': '💬',
  'us.zoom.xos': '📹',
  'notion.id': '📔',
  'com.figma.Desktop': '🎨',
};

// 名字小写包含某段就映射（处理 label 不规范）
const NAME_SUBSTRING_EMOJI: Array<[string, string]> = [
  ['wechat', '💬'],
  ['weixin', '💬'],
  ['safari', '🧭'],
  ['chrome', '🌐'],
  ['firefox', '🦊'],
  ['mail', '📮'],
  ['notes', '📝'],
  ['terminal', '⌨️'],
  ['finder', '📁'],
  ['slack', '💬'],
  ['notion', '📔'],
  ['figma', '🎨'],
  ['vscode', '💻'],
  ['code', '💻'],
];

function emojiForApp(label?: string, iconHint?: string): string | null {
  if (iconHint && BUNDLE_ID_EMOJI[iconHint]) return BUNDLE_ID_EMOJI[iconHint];
  const haystack = `${label || ''} ${iconHint || ''}`.toLowerCase();
  for (const [key, emoji] of NAME_SUBSTRING_EMOJI) {
    if (haystack.includes(key)) return emoji;
  }
  return null;
}

interface Props {
  targetContext?: ToolCallTargetContext;
  className?: string;
}

export function TargetContextIcon({ targetContext, className = '' }: Props) {
  if (!targetContext?.kind) return null;

  const kind = targetContext.kind;

  // app: 优先 emoji，没匹配 fallback Monitor lucide
  if (kind === 'app') {
    const emoji = emojiForApp(targetContext.label, targetContext.iconHint);
    if (emoji) {
      return <span className={`text-sm leading-none ${className}`} aria-label={targetContext.label}>{emoji}</span>;
    }
    return <Monitor size={12} className={`text-zinc-400 ${className}`} aria-label={targetContext.label} />;
  }

  if (kind === 'browser') {
    return <Globe size={12} className={`text-cyan-400 ${className}`} aria-label={targetContext.label || 'Browser'} />;
  }

  if (kind === 'mcp_server') {
    return <Plug size={12} className={`text-purple-400 ${className}`} aria-label={targetContext.label || 'MCP'} />;
  }

  if (kind === 'file') {
    return <FileText size={12} className={`text-blue-400 ${className}`} aria-label={targetContext.label || 'File'} />;
  }

  if (kind === 'memory') {
    return <Brain size={12} className={`text-amber-400 ${className}`} aria-label={targetContext.label || 'Memory'} />;
  }

  // 兜底：未知 kind 用 MessageCircle
  return <MessageCircle size={12} className={`text-zinc-500 ${className}`} />;
}
