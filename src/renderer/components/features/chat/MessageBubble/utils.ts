// ============================================================================
// MessageBubble Utilities
// ============================================================================

import type { MarkdownBlockData, LanguageConfig, AttachmentIconConfig } from './types';
import type { AttachmentCategory } from '@shared/types';

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
  typescript: { color: 'text-blue-400' },
  javascript: { color: 'text-yellow-400' },
  python: { color: 'text-green-400' },
  rust: { color: 'text-orange-400' },
  go: { color: 'text-cyan-400' },
  bash: { color: 'text-emerald-400' },
  shell: { color: 'text-emerald-400' },
  json: { color: 'text-amber-400' },
  html: { color: 'text-orange-400' },
  css: { color: 'text-blue-400' },
  sql: { color: 'text-purple-400' },
};

// Folder summary threshold
export const FOLDER_SUMMARY_THRESHOLD = 5;

// Parse markdown into blocks
export function parseMarkdownBlocks(text: string): MarkdownBlockData[] {
  const blocks: MarkdownBlockData[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr', content: '' });
      i++;
      continue;
    }

    // Heading (# to ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Table detection
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].match(/^[\s|:-]+$/)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') });
      continue;
    }

    // Unordered list (-, *, +)
    const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+])\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[3]);
          i++;
        } else if (lines[i].trim() === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', content: '', items, ordered: false });
      continue;
    }

    // Ordered list (1. 2. etc)
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[3]);
          i++;
        } else if (lines[i].trim() === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', content: '', items, ordered: true });
      continue;
    }

    // Regular paragraph - collect consecutive non-special lines
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const currentLine = lines[i];
      // Stop at special lines
      if (
        currentLine.match(/^#{1,6}\s/) ||
        currentLine.startsWith('>') ||
        currentLine.match(/^(\s*)([-*+]|\d+\.)\s/) ||
        (currentLine.includes('|') && i + 1 < lines.length && lines[i + 1]?.match(/^[\s|:-]+$/)) ||
        currentLine.match(/^(-{3,}|\*{3,}|_{3,})$/)
      ) {
        break;
      }
      paragraphLines.push(currentLine);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') });
    }
  }

  return blocks;
}

// Category labels for attachments
export const categoryLabels: Record<string, string> = {
  image: '图片',
  pdf: 'PDF',
  code: '代码',
  data: '数据',
  text: '文本',
  html: 'HTML',
  other: '其他',
};
