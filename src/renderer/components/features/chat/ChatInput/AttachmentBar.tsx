// ============================================================================
// AttachmentBar - 附件栏组件（显示已添加的附件）
// ============================================================================

import React from 'react';
import { X, FileText, Code, Database, Globe, File, Folder } from 'lucide-react';
import type { MessageAttachment, AttachmentCategory } from '../../../../../shared/types';
import { IconButton } from '../../../primitives';

export interface AttachmentBarProps {
  /** 附件列表 */
  attachments: MessageAttachment[];
  /** 移除附件回调 */
  onRemove: (id: string) => void;
}

/**
 * 根据附件类别返回对应图标
 */
const AttachmentIcon: React.FC<{ category: AttachmentCategory }> = ({ category }) => {
  const iconClass = 'w-5 h-5';
  switch (category) {
    case 'pdf':
      return <FileText className={`${iconClass} text-red-400`} />;
    case 'code':
      return <Code className={`${iconClass} text-blue-400`} />;
    case 'data':
      return <Database className={`${iconClass} text-amber-400`} />;
    case 'html':
      return <Globe className={`${iconClass} text-orange-400`} />;
    case 'text':
      return <FileText className={`${iconClass} text-zinc-400`} />;
    case 'folder':
      return <Folder className={`${iconClass} text-yellow-400`} />;
    default:
      return <File className={`${iconClass} text-zinc-500`} />;
  }
};

/**
 * 单个附件项
 */
const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  onRemove: () => void;
}> = ({ attachment, onRemove }) => {
  const att = attachment;

  // 获取附件描述
  const getDescription = () => {
    if (att.category === 'folder' && att.folderStats) {
      return `${att.folderStats.totalFiles} 个文件`;
    }
    if (att.category === 'pdf' && att.pageCount) {
      return `${att.pageCount} 页`;
    }
    if (att.language) {
      return att.language;
    }
    return `${(att.size / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="relative group flex items-center gap-2 px-3 py-2 bg-zinc-800/60 rounded-lg border border-zinc-700/50">
      {att.category === 'image' ? (
        <>
          <img
            src={att.thumbnail}
            alt={att.name}
            className="w-10 h-10 object-cover rounded"
          />
          <div className="flex flex-col">
            <span className="text-xs text-zinc-300 truncate max-w-[120px]">
              {att.name}
            </span>
            <span className="text-2xs text-zinc-500">
              {(att.size / 1024).toFixed(1)} KB
            </span>
          </div>
        </>
      ) : (
        <>
          <AttachmentIcon category={att.category} />
          <div className="flex flex-col">
            <span className="text-xs text-zinc-300 truncate max-w-[120px]">
              {att.name}
            </span>
            <span className="text-2xs text-zinc-500">{getDescription()}</span>
          </div>
        </>
      )}
      <IconButton
        icon={<X className="w-3 h-3" />}
        aria-label="移除附件"
        onClick={onRemove}
        variant="danger"
        size="sm"
        className="absolute -top-1.5 -right-1.5 !p-0.5 !w-5 !h-5 bg-zinc-700 hover:!bg-red-500 !rounded-full !text-white opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </div>
  );
};

/**
 * 附件栏 - 显示已添加的附件列表
 */
export const AttachmentBar: React.FC<AttachmentBarProps> = ({
  attachments,
  onRemove,
}) => {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 mb-3 px-2">
      {attachments.map((att) => (
        <AttachmentItem
          key={att.id}
          attachment={att}
          onRemove={() => onRemove(att.id)}
        />
      ))}
    </div>
  );
};

export default AttachmentBar;
