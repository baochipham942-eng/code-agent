// ============================================================================
// CaptureDetail - 采集内容详情视图
// ============================================================================

import React from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Globe, ExternalLink, Clock, Tag } from 'lucide-react';
import type { CaptureItem } from '@shared/types/capture';

interface CaptureDetailProps {
  item: CaptureItem;
  onClose: () => void;
}

export const CaptureDetail: React.FC<CaptureDetailProps> = ({ item, onClose }) => {
  return (
    <div className="flex flex-col h-full bg-[#1c1c21] border-l border-border-default">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
        <h3 className="text-sm font-medium text-text-primary truncate flex-1">{item.title}</h3>
        <button
          onClick={onClose}
          className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 元信息 */}
      <div className="px-4 py-2 border-b border-border-default flex flex-wrap gap-3 text-xs text-text-tertiary">
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-text-secondary transition-colors"
          >
            <Globe className="w-3 h-3" />
            <span className="truncate max-w-[200px]">{new URL(item.url).hostname}</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <span className="inline-flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {new Date(item.createdAt).toLocaleString('zh-CN')}
        </span>
        {item.tags.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Tag className="w-3 h-3" />
            {item.tags.join(', ')}
          </span>
        )}
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown>{item.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
