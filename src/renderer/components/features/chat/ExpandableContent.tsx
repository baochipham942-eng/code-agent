// ============================================================================
// ExpandableContent - 长内容截断 + 展开/折叠
// ============================================================================

import React, { useState, useMemo } from 'react';

interface ExpandableContentProps {
  content: string;
  maxLines?: number;
  maxLength?: number;
  language?: string;
  className?: string;
}

export const ExpandableContent: React.FC<ExpandableContentProps> = ({
  content,
  maxLines = 20,
  maxLength = 2000,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(false);

  const { truncated, displayContent, totalLines } = useMemo(() => {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const needsTruncate = totalLines > maxLines || content.length > maxLength;

    if (!needsTruncate || expanded) {
      return { truncated: false, displayContent: content, totalLines };
    }

    // Truncate by lines first, then by length
    let result = lines.slice(0, maxLines).join('\n');
    if (result.length > maxLength) {
      result = result.slice(0, maxLength);
    }

    return { truncated: true, displayContent: result, totalLines };
  }, [content, maxLines, maxLength, expanded]);

  return (
    <div className={className}>
      <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words font-mono leading-relaxed overflow-hidden">
        {displayContent}
      </pre>
      {truncated && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-primary-400 hover:text-primary-300 transition-colors"
        >
          展开更多 (共 {totalLines} 行)
        </button>
      )}
      {expanded && content.split('\n').length > maxLines && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-1 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
        >
          收起
        </button>
      )}
    </div>
  );
};
