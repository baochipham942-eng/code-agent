// ============================================================================
// LinkPreviewCard - raw URL（children === href）的渲染出口
// 轻呈现 + favicon：16px 站点图标 + 下划线链接，无 chip 边框/底色/彩色块。
// favicon 帮用户一眼认出是哪个站点（比读 URL 高效），图标加载失败自动隐藏，
// 只留链接文本，不破坏行内流。
// ============================================================================

import React, { useState } from 'react';
import { openExternalLink } from '../../../../utils/platform';

interface LinkPreviewCardProps {
  href: string;
}

function safeHostname(href: string): string | null {
  try {
    const url = new URL(href);
    return url.hostname;
  } catch {
    return null;
  }
}

export const LinkPreviewCard: React.FC<LinkPreviewCardProps> = ({ href }) => {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const hostname = safeHostname(href);

  if (!hostname) {
    // 非合法 URL fallback 到普通 a 标签
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { if (openExternalLink(href)) e.preventDefault(); }}
        className="text-primary-400 hover:text-primary-300 underline underline-offset-2 cursor-pointer"
      >
        {href}
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={(e) => { if (openExternalLink(href)) e.preventDefault(); }}
      className="text-sky-400/80 hover:text-sky-300 underline decoration-sky-400/30 underline-offset-2 cursor-pointer break-all"
    >
      {!faviconFailed && (
        <img
          src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
          alt=""
          loading="lazy"
          onError={() => setFaviconFailed(true)}
          className="mr-1 inline-block h-4 w-4 rounded-[3px] align-[-2px]"
        />
      )}
      {href}
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
