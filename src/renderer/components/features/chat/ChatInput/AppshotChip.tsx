// ============================================================================
// AppshotChip — composer 里待发送的 Appshot 预览卡
// 竖排卡（缩略图 w-60 h-[7.5rem]，飞入落点锚与之重合）+ app 图标单行标题；
// 文字就绪前在截图底部浮「识别中…」小 pill，就绪后不标注。
// 点击开预览 Modal（截图/文字切换），可移除（X 贴图角）。
// ============================================================================

import React, { useState } from 'react';
import { Download, FileText, X, Image as ImageIcon } from 'lucide-react';
import type { AppshotCapture, AppshotTextSource } from '@shared/contract/appshot';
import { Modal } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppIcon } from '../../../../hooks/useAppIcon';
import type { Translations } from '../../../../i18n/zh';

// 与 Rust 侧 AX_TEXT_MAX_CHARS 对齐：axText 达到该长度即视为被截断。
const APPSHOT_TEXT_LIMIT = 4000;

export interface AppshotChipProps {
  capture: AppshotCapture;
  /** 不传则不显示移除按钮（消息气泡等只读场景） */
  onRemove?: () => void;
  /** 飞入 handoff 前的占位态：结构已在 DOM（尺寸=落点），但整体不可见，handoff 后零位移显形 */
  reserved?: boolean;
}

function textSourceLabel(t: Translations, source: AppshotTextSource): { label: string; className: string } {
  switch (source) {
    case 'ax':
      return { label: t.appshotChip.textSourceAx, className: 'text-emerald-400' };
    case 'ocr':
      return { label: t.appshotChip.textSourceOcr, className: 'text-amber-400' };
    default:
      return { label: t.appshotChip.textSourceNone, className: 'text-zinc-500' };
  }
}

export const AppshotChip: React.FC<AppshotChipProps> = ({ capture, onRemove, reserved = false }) => {
  const { t } = useI18n();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [view, setView] = useState<'image' | 'text'>('image');
  const source = textSourceLabel(t, capture.textSource);
  const text = capture.axText?.trim() || t.appshotChip.noTextFallback;
  const textChars = capture.axText?.trim().length ?? 0;
  const textTruncated = textChars >= APPSHOT_TEXT_LIMIT;
  const appIcon = useAppIcon(capture.bundleId ?? capture.appName ?? undefined, 32);
  const appName = capture.appName || 'Appshot';
  const windowTitle = capture.windowTitle?.trim() || '';
  // Modal 头部用：标题为空或与 app 名重复时不显示副行
  const singleLine = !windowTitle || windowTitle === appName;

  const handleDownload = () => {
    if (!capture.screenshotDataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = capture.screenshotDataUrl;
    anchor.download = `${capture.appName || 'Appshot'}${t.appshotChip.screenshotFilenameSuffix}`;
    anchor.click();
  };

  return (
    <>
      <div
        className={`relative group w-fit${reserved ? ' opacity-0' : ''}`}
        aria-hidden={reserved || undefined}
      >
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="flex w-fit flex-col gap-1.5 rounded-xl border border-zinc-700 bg-zinc-700/60 p-2 text-left transition-colors hover:border-zinc-500 hover:bg-zinc-700"
          aria-label={t.appshotChip.viewAria}
        >
          {/* 缩略图矩形即飞入落点：ComposerChipsRow 的 appshotSlotRef 锚必须与其重合
              （left 9px = border 1 + p-2 8；img w-60 h-[7.5rem]，其下缘距卡下缘 35px = gap-1.5 6 + 标题行 h-5 20 + p-2 8 + border 1） */}
          <div className="relative">
            {capture.screenshotDataUrl ? (
              <img
                src={capture.screenshotDataUrl}
                alt={appName}
                title={windowTitle || appName}
                className="w-60 h-[7.5rem] shrink-0 rounded-md bg-black/30 object-contain"
              />
            ) : (
              <div className="w-60 h-[7.5rem] shrink-0 flex items-center justify-center rounded-md bg-zinc-800">
                <ImageIcon className="w-5 h-5 text-zinc-500" />
              </div>
            )}
            {/* 状态：text_ready 前显示「识别中…」软 pill（不撑布局、不喧宾夺主）；
                文字补齐后不再标注——卡片上已有图，状态自明 */}
            {!capture.textReady && (
              <span className="absolute inset-x-0 bottom-1.5 flex justify-center">
                <span className="rounded-full bg-black/45 px-2 py-px text-[10px] leading-4 text-zinc-200 backdrop-blur-sm">
                  {t.appshotChip.recognizing}
                </span>
              </span>
            )}
          </div>
          {/* 标题行：app 图标 + 窗口标题（无标题时回落 app 名；app 名文字行省略，logo 已代表） */}
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {appIcon ? (
              <img src={appIcon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
            ) : (
              <ImageIcon className="h-4 w-4 shrink-0 text-zinc-500" />
            )}
            <span className="truncate max-w-[13.5rem] text-xs text-zinc-200">
              {windowTitle || appName}
            </span>
          </div>
        </button>
        {/* 移除：卡外贴角圆形按钮（Codex 式，点击目标大），只在传了 onRemove 时显示（composer 场景） */}
        {onRemove && (
          <button
            type="button"
            aria-label={t.appshotChip.removeAria}
            onClick={onRemove}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-500 bg-zinc-600 text-white shadow-md transition hover:bg-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        size="full"
        portal
        className="max-w-5xl"
        header={(
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium text-zinc-200">
                {singleLine ? appName : windowTitle}
              </h2>
              {!singleLine && (
                <p className="truncate text-xs text-zinc-500">{appName}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-zinc-800 p-1">
              <button
                type="button"
                onClick={() => setView('image')}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${view === 'image' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <ImageIcon className="h-3.5 w-3.5" />
                {t.appshotChip.screenshotTab}
              </button>
              <button
                type="button"
                onClick={() => setView('text')}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${view === 'text' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <FileText className="h-3.5 w-3.5" />
                {t.appshotChip.textTab}
              </button>
            </div>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!capture.screenshotDataUrl}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
              aria-label={t.appshotChip.downloadAria}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
              aria-label={t.appshotChip.closeAria}
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
                  {t.appshotChip.screenshotLoading}
                </div>
              )}
            </div>
          ) : (
            <div>
              <pre className="max-h-[64vh] overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 text-sm leading-6 text-zinc-200">
                {text}
              </pre>
              <div className="mt-2 flex items-center gap-1.5 text-2xs text-zinc-500">
                <span className={source.className}>{source.label}</span>
                <span>·</span>
                <span>{t.appshotChip.textChars.replace('{count}', String(textChars))}</span>
                {textTruncated && (
                  <>
                    <span>·</span>
                    <span className="text-amber-400">{t.appshotChip.textTruncated}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
};

export default AppshotChip;
