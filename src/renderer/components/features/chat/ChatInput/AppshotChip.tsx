// ============================================================================
// AppshotChip — composer 里待发送的 Appshot 预览片
// 显示窗口截图缩略图 + app 名/窗口标题 + 文本来源（AX / OCR / 仅图），可移除。
// 样式对齐 AttachmentBar 的 AttachmentItem。
// ============================================================================

import React from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import type { AppshotCapture, AppshotTextSource } from '@shared/contract/appshot';
import { IconButton } from '../../../primitives';

export interface AppshotChipProps {
  capture: AppshotCapture;
  onRemove: () => void;
}

function textSourceLabel(source: AppshotTextSource): { label: string; className: string } {
  switch (source) {
    case 'ax':
      return { label: '已读取窗口文字', className: 'text-emerald-400' };
    case 'ocr':
      return { label: 'OCR 识别文字', className: 'text-amber-400' };
    default:
      return { label: '仅截图 · 无文字', className: 'text-zinc-500' };
  }
}

export const AppshotChip: React.FC<AppshotChipProps> = ({ capture, onRemove }) => {
  const source = textSourceLabel(capture.textSource);

  return (
    <div className="relative group flex items-center gap-2 px-3 py-2 bg-zinc-700/60 rounded-lg border border-zinc-700 max-w-[260px]">
      {capture.screenshotDataUrl ? (
        <img
          src={capture.screenshotDataUrl}
          alt={capture.appName}
          className="w-10 h-10 object-cover rounded"
        />
      ) : (
        <div className="w-10 h-10 flex items-center justify-center rounded bg-zinc-800">
          <ImageIcon className="w-5 h-5 text-zinc-500" />
        </div>
      )}
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-zinc-300 truncate max-w-[160px]">
          {capture.appName || 'Appshot'}
        </span>
        {capture.windowTitle && (
          <span className="text-2xs text-zinc-500 truncate max-w-[160px]">
            {capture.windowTitle}
          </span>
        )}
        <span className={`text-2xs ${source.className}`}>{source.label}</span>
      </div>
      <IconButton
        icon={<X className="w-3 h-3" />}
        aria-label="移除 Appshot"
        onClick={onRemove}
        variant="danger"
        size="sm"
        className="absolute -top-1.5 -right-1.5 !p-0.5 !w-5 !h-5 bg-zinc-600 hover:!bg-red-500 !rounded-full !text-white opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </div>
  );
};

export default AppshotChip;
