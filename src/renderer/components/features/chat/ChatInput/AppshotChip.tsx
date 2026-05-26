// ============================================================================
// AppshotChip — composer 里待发送的 Appshot 预览片
// 显示窗口截图缩略图 + app 名/窗口标题 + 文本来源（AX / OCR / 仅图），可移除。
// 样式对齐 AttachmentBar 的 AttachmentItem。
// ============================================================================

import React, { useState } from 'react';
import { Download, FileText, X, Image as ImageIcon } from 'lucide-react';
import type { AppshotCapture, AppshotTextSource } from '@shared/contract/appshot';
import { IconButton, Modal } from '../../../primitives';

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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [view, setView] = useState<'image' | 'text'>('image');
  const source = textSourceLabel(capture.textSource);
  const text = capture.axText?.trim() || '未读取到窗口文字';

  const handleDownload = () => {
    if (!capture.screenshotDataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = capture.screenshotDataUrl;
    anchor.download = `${capture.appName || 'Appshot'} 截图.png`;
    anchor.click();
  };

  return (
    <>
      <div className="relative group max-w-[260px]">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-700/60 px-3 py-2 text-left transition-colors hover:border-zinc-500 hover:bg-zinc-700"
          aria-label="查看 Appshot"
        >
          {capture.screenshotDataUrl ? (
            <img
              src={capture.screenshotDataUrl}
              alt={capture.appName}
              className="w-10 h-10 shrink-0 object-cover rounded"
            />
          ) : (
            <div className="w-10 h-10 shrink-0 flex items-center justify-center rounded bg-zinc-800">
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
        </button>
        <IconButton
          icon={<X className="w-3 h-3" />}
          aria-label="移除 Appshot"
          onClick={onRemove}
          variant="danger"
          size="sm"
          className="absolute -top-1.5 -right-1.5 !p-0.5 !w-5 !h-5 bg-zinc-600 hover:!bg-red-500 !rounded-full !text-white opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>

      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        size="full"
        className="max-w-5xl"
        header={(
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium text-zinc-200">
                {capture.appName || 'Appshot'}
              </h2>
              {capture.windowTitle && (
                <p className="truncate text-xs text-zinc-500">{capture.windowTitle}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-zinc-800 p-1">
              <button
                type="button"
                onClick={() => setView('image')}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${view === 'image' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <ImageIcon className="h-3.5 w-3.5" />
                截图
              </button>
              <button
                type="button"
                onClick={() => setView('text')}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${view === 'text' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <FileText className="h-3.5 w-3.5" />
                文字
              </button>
            </div>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!capture.screenshotDataUrl}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
              aria-label="下载截图"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        showCloseButton={false}
      >
        <div className="min-h-[52vh]">
          {view === 'image' ? (
            <div className="flex max-h-[68vh] items-center justify-center overflow-auto rounded-lg bg-black/30">
              {capture.screenshotDataUrl ? (
                <img
                  src={capture.screenshotDataUrl}
                  alt={capture.appName || 'Appshot'}
                  className="max-h-[68vh] max-w-full object-contain"
                />
              ) : (
                <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
                  截图仍在读取
                </div>
              )}
            </div>
          ) : (
            <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 text-sm leading-6 text-zinc-200">
              {text}
            </pre>
          )}
        </div>
      </Modal>
    </>
  );
};

export default AppshotChip;
