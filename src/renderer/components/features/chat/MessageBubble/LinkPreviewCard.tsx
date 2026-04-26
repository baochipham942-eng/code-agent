// ============================================================================
// LinkPreviewCard - inline 链接预览 chip
// raw URL（children === href）渲染为 favicon + 友好域名标签的小卡，对照 Codex /
// Slack 的链接 chip 样式。非 raw URL 仍走普通 a 标签。
// ============================================================================

import React from 'react';
import { ExternalLink } from 'lucide-react';

interface LinkPreviewCardProps {
  href: string;
}

const HOSTNAME_LABEL_MAP: Array<{ test: RegExp; label: string }> = [
  { test: /(?:^|\.)feishu\.cn$/, label: '飞书' },
  { test: /(?:^|\.)larksuite\.com$/, label: 'Lark' },
  { test: /(?:^|\.)larkoffice\.com$/, label: 'Lark' },
  { test: /(?:^|\.)github\.com$/, label: 'GitHub' },
  { test: /(?:^|\.)notion\.so$/, label: 'Notion' },
  { test: /(?:^|\.)notion\.site$/, label: 'Notion' },
  { test: /^mp\.weixin\.qq\.com$/, label: '微信公众号' },
  { test: /(?:^|\.)zhihu\.com$/, label: '知乎' },
  { test: /(?:^|\.)bilibili\.com$/, label: 'B 站' },
  { test: /(?:^|\.)twitter\.com$/, label: 'Twitter' },
  { test: /(?:^|\.)x\.com$/, label: 'X' },
  { test: /(?:^|\.)youtube\.com$/, label: 'YouTube' },
  { test: /^youtu\.be$/, label: 'YouTube' },
  { test: /(?:^|\.)arxiv\.org$/, label: 'arXiv' },
];

function deriveLabel(hostname: string): string {
  for (const { test, label } of HOSTNAME_LABEL_MAP) {
    if (test.test(hostname)) return label;
  }
  return hostname.replace(/^www\./, '');
}

function safeHostname(href: string): string | null {
  try {
    const url = new URL(href);
    return url.hostname;
  } catch {
    return null;
  }
}

function shortenPath(href: string): string {
  try {
    const url = new URL(href);
    const tail = `${url.pathname}${url.search}`.replace(/\/$/, '');
    if (!tail || tail === '/') return '';
    if (tail.length > 24) return `…${tail.slice(-22)}`;
    return tail;
  } catch {
    return '';
  }
}

export const LinkPreviewCard: React.FC<LinkPreviewCardProps> = ({ href }) => {
  const hostname = safeHostname(href);
  if (!hostname) {
    // 非合法 URL fallback 到普通 a 标签
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-400 hover:text-primary-300 underline underline-offset-2"
      >
        {href}
      </a>
    );
  }

  const label = deriveLabel(hostname);
  const tail = shortenPath(href);
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 mx-0.5 rounded-md bg-zinc-800/60 hover:bg-zinc-700 border border-zinc-700/60 hover:border-zinc-600 text-zinc-300 hover:text-zinc-100 transition-colors text-[0.92em] no-underline align-baseline max-w-full"
    >
      <img
        src={faviconSrc}
        alt=""
        loading="lazy"
        className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
      <span className="font-medium flex-shrink-0">{label}</span>
      {tail && (
        <span className="text-zinc-500 truncate max-w-[160px] font-mono text-[0.9em]">
          {tail}
        </span>
      )}
      <ExternalLink className="w-2.5 h-2.5 text-zinc-500 flex-shrink-0" />
    </a>
  );
};

/**
 * 判定是否应该用 LinkPreviewCard：children 为字符串且 trim 后等于 href（即 raw URL）。
 */
export function isRawUrlLink(href: string, children: React.ReactNode): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  let text: string;
  if (typeof children === 'string') {
    text = children;
  } else if (Array.isArray(children)) {
    text = children.map((c) => (typeof c === 'string' ? c : '')).join('');
  } else {
    return false;
  }
  return text.trim() === href.trim();
}
