// ============================================================================
// CaptureCard - 采集内容卡片组件
// ============================================================================

import React from 'react';
import { Globe, FileText, MessageCircle, FolderOpen, Trash2, ExternalLink } from 'lucide-react';
import type { CaptureItem, CaptureSource } from '@shared/types/capture';

const SOURCE_CONFIG: Record<CaptureSource, { icon: React.ReactNode; label: string; color: string }> = {
  browser_extension: { icon: <Globe className="w-3 h-3" />, label: '网页', color: 'text-blue-400 bg-blue-500/20' },
  manual: { icon: <FileText className="w-3 h-3" />, label: '手动', color: 'text-zinc-400 bg-zinc-500/20' },
  wechat: { icon: <MessageCircle className="w-3 h-3" />, label: '微信', color: 'text-green-400 bg-green-500/20' },
  local_file: { icon: <FolderOpen className="w-3 h-3" />, label: '本地文件', color: 'text-amber-400 bg-amber-500/20' },
};

function getRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}月前`;
}

interface CaptureCardProps {
  item: CaptureItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export const CaptureCard: React.FC<CaptureCardProps> = ({ item, isSelected, onSelect, onDelete }) => {
  const sourceConfig = SOURCE_CONFIG[item.source];

  return (
    <div
      onClick={() => onSelect(item.id)}
      className={`group relative px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150 ${
        isSelected
          ? 'bg-zinc-700/50 border border-zinc-600'
          : 'hover:bg-zinc-800/50 border border-transparent'
      }`}
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`text-sm font-medium truncate flex-1 ${
          isSelected ? 'text-zinc-100' : 'text-zinc-300'
        }`}>
          {item.title}
        </span>
        <span className="text-xs text-zinc-500 shrink-0">
          {getRelativeTime(item.createdAt)}
        </span>
      </div>

      {/* 摘要 */}
      <p className="text-xs text-zinc-500 line-clamp-2 mb-2">
        {item.summary || item.content.substring(0, 120)}
      </p>

      {/* 底部：来源标签 + 操作 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${sourceConfig.color}`}>
            {sourceConfig.icon}
            {sourceConfig.label}
          </span>
          {item.tags.slice(0, 2).map(tag => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400">
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {item.url && (
            <button
              onClick={(e) => { e.stopPropagation(); window.open(item.url, '_blank'); }}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="打开原始链接"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
            className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
