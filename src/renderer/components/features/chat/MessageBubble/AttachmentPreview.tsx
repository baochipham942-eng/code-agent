// ============================================================================
// AttachmentPreview - Display attachments in messages
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderSearch,
  Image as ImageIcon,
  File,
  FileText,
  FileCode,
  Database,
  Globe,
  Sheet,
} from 'lucide-react';
import type { AttachmentDisplayProps, AttachmentIconConfig } from './types';
import type { AttachmentCategory, MessageAttachment } from '@shared/types';
import { formatFileSize, FOLDER_SUMMARY_THRESHOLD, categoryLabels } from './utils';

// Get attachment icon config based on category
function getAttachmentIconConfig(category: AttachmentCategory | undefined): AttachmentIconConfig {
  const iconClass = "w-5 h-5 shrink-0";
  switch (category) {
    case 'pdf':
      return { icon: <FileText className={iconClass} />, color: 'text-red-400', label: 'PDF' };
    case 'excel':
      return { icon: <Sheet className={iconClass} />, color: 'text-emerald-400', label: 'Excel' };
    case 'code':
      return { icon: <FileCode className={iconClass} />, color: 'text-blue-400', label: '代码' };
    case 'data':
      return { icon: <Database className={iconClass} />, color: 'text-amber-400', label: '数据' };
    case 'html':
      return { icon: <Globe className={iconClass} />, color: 'text-orange-400', label: 'HTML' };
    case 'text':
      return { icon: <FileText className={iconClass} />, color: 'text-zinc-400', label: '文本' };
    default:
      return { icon: <File className={iconClass} />, color: 'text-zinc-500', label: '文件' };
  }
}

// Single attachment item
const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  onImageClick: (src: string) => void;
}> = ({ attachment, onImageClick }) => {
  const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');

  if (category === 'image') {
    return (
      <div
        className="relative group cursor-pointer"
        onClick={() => onImageClick(attachment.thumbnail || attachment.data || '')}
      >
        <img
          src={attachment.thumbnail || attachment.data}
          alt={attachment.name}
          className="max-w-[200px] max-h-[150px] rounded-xl border border-zinc-700/50 shadow-lg object-cover hover:border-primary-500/50 transition-colors"
        />
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
          <ImageIcon className="w-6 h-6 text-white" />
        </div>
      </div>
    );
  }

  const { icon, color, label } = getAttachmentIconConfig(category);
  // Only show file name without folder path
  const displayName = attachment.name.includes('/')
    ? attachment.name.split('/').pop() || attachment.name
    : attachment.name;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-800/60 border border-zinc-700/50 max-w-[200px]">
      <span className={color}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200 truncate" title={attachment.name}>
          {displayName}
        </div>
        <div className="text-xs text-zinc-500 flex items-center gap-1">
          <span className={`${color} text-2xs`}>{label}</span>
          <span>·</span>
          {category === 'pdf' && attachment.pageCount
            ? <span>{attachment.pageCount} 页</span>
            : category === 'excel' && attachment.sheetCount
              ? <span>{attachment.sheetCount} 表 · {attachment.rowCount} 行</span>
              : attachment.language
                ? <span>{attachment.language}</span>
                : <span>{formatFileSize(attachment.size)}</span>
          }
        </div>
      </div>
    </div>
  );
};

// Main attachment display component
export const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({ attachments }) => {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate stats
  const stats = useMemo(() => {
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const att of attachments) {
      const cat = att.category || (att.type === 'image' ? 'image' : 'other');
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      totalSize += att.size;
    }

    // Check if from same folder
    const firstSlash = attachments[0]?.name.indexOf('/');
    const folderName = firstSlash > 0 ? attachments[0].name.substring(0, firstSlash) : null;
    const isFromFolder = folderName && attachments.every((a) => a.name.startsWith(folderName + '/'));

    return { byCategory, totalSize, folderName: isFromFolder ? folderName : null };
  }, [attachments]);

  // Show summary if file count exceeds threshold
  const showSummary = attachments.length > FOLDER_SUMMARY_THRESHOLD;

  // Summary view
  if (showSummary && !isExpanded) {
    const summaryParts = Object.entries(stats.byCategory)
      .map(([cat, count]) => `${count} ${categoryLabels[cat] || cat}`)
      .join(', ');

    return (
      <div className="mb-2 flex justify-end">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-800/60 border border-zinc-700/50 cursor-pointer hover:bg-zinc-700/60 transition-colors"
          onClick={() => setIsExpanded(true)}
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary-500/20 to-accent-purple/20 flex items-center justify-center">
            <FolderSearch className="w-5 h-5 text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-zinc-200 font-medium">
              {stats.folderName ? `📁 ${stats.folderName}` : `📎 ${attachments.length} 个文件`}
            </div>
            <div className="text-xs text-zinc-500">
              {summaryParts} · {formatFileSize(stats.totalSize)}
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      {/* Collapse button when expanded */}
      {showSummary && isExpanded && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setIsExpanded(false)}
            className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
          >
            <ChevronDown className="w-3 h-3" />
            收起 {attachments.length} 个文件
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex flex-wrap gap-2 justify-end">
        {attachments.map((attachment) => (
          <AttachmentItem
            key={attachment.id}
            attachment={attachment}
            onImageClick={setExpandedImage}
          />
        ))}
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};
