// ============================================================================
// 录音清理失败行 —— 裸 errno 不进主文案
// 主文案按错误分类讲人话并给出路（打开文件夹 / 重试）；
// 原始错误串（含绝对路径）只进默认折叠的 <details>。
// ============================================================================

import React from 'react';
import { openNativePath } from '../../../../services/tauriPluginFacade';
import { interpolate } from '../../../../i18n/interpolate';

/** 失败行用到的文案键（zh/en 同构，真源在 i18n settings 的 audioRetention 块） */
interface AudioRetentionFailureText {
  failedPermission: string;
  failedOther: string;
  openFolder: string;
  retry: string;
  details: string;
}

/** lastError 含 EACCES/EPERM（不区分大小写）→ 权限类；其余（含缺失）→ 其他 */
function classifyRetentionError(lastError: string | undefined): 'permission' | 'other' {
  if (!lastError) return 'other';
  const upper = lastError.toUpperCase();
  return upper.includes('EACCES') || upper.includes('EPERM') ? 'permission' : 'other';
}

export const AudioRetentionFailureLine: React.FC<{
  failedTotal: number;
  lastError?: string;
  audioDir: string;
  text: AudioRetentionFailureText;
  onRetry: () => void;
}> = ({ failedTotal, lastError, audioDir, text, onRetry }) => {
  const handleOpenFolder = () => {
    // 打开失败只留痕不打断（fail-open 但不静默：错题本 2026-08-14）
    openNativePath(audioDir).catch((error) => {
      console.warn('audioRetention: failed to open recordings folder', error);
    });
  };
  const main = interpolate(
    classifyRetentionError(lastError) === 'permission' ? text.failedPermission : text.failedOther,
    { count: failedTotal },
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-1.5 text-[11px] text-badge-danger shrink-0">
      <span>{main}</span>
      <button /* ds-allow:button: 失败行内联文字链接式小 chip，primitive 变体会强加 bg/padding 改变外观 */
        type="button"
        onClick={handleOpenFolder}
        className="underline underline-offset-2 hover:text-zinc-200 transition-colors"
      >
        {text.openFolder}
      </button>
      <button /* ds-allow:button: 失败行内联文字链接式小 chip，primitive 变体会强加 bg/padding 改变外观 */
        type="button"
        onClick={onRetry}
        className="underline underline-offset-2 hover:text-zinc-200 transition-colors"
      >
        {text.retry}
      </button>
      {lastError ? (
        <details className="text-zinc-400 max-w-full">
          <summary className="cursor-pointer">{text.details}</summary>
          <code className="block break-all font-mono">{lastError}</code>
        </details>
      ) : null}
    </div>
  );
};
