// ============================================================================
// MessageBubble Utilities
// ============================================================================

import type { LanguageConfig } from './types';

// Format timestamp to readable time
export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

// Format file size to human readable
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Language colors for code blocks
export const languageConfig: Record<string, LanguageConfig> = {
  typescript: { color: 'text-badge-info' },
  javascript: { color: 'text-badge-warning' },
  python: { color: 'text-badge-success' },
  rust: { color: 'text-badge-warning' },
  go: { color: 'text-badge-info' },
  bash: { color: 'text-badge-success' },
  shell: { color: 'text-badge-success' },
  json: { color: 'text-badge-warning' },
  html: { color: 'text-badge-warning' },
  css: { color: 'text-badge-info' },
  sql: { color: 'text-badge-accent' },
};

// Folder summary threshold
export const FOLDER_SUMMARY_THRESHOLD = 5;


// Category labels for attachments
export const categoryLabels: Record<string, string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
  excel: '表格',
  presentation: '演示文稿',
  archive: '压缩包',
  code: '代码',
  data: '数据',
  text: '文本',
  html: 'HTML',
  other: '其他',
};
