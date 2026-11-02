// ============================================================================
// 应用缓存清理失败行 —— 结构与 audioRetentionFailure 同款（裸 errno 不进主文案）
// ----------------------------------------------------------------------------
// 数据页版盖 appCacheRetention（channel-media / 托管浏览器截图 / appshots）+
// presentationPreviewRetention（pptx 逐页预览）两家的聚合账（failedCurrent 求和）。
// 主文案按错误分类讲人话并给出路（打开数据文件夹 / 重试）；
// 原始错误串（含绝对路径）只进默认折叠的 <details>。
// ============================================================================

import React from 'react';
import { openNativePath } from '../../../../services/tauriPluginFacade';
import { interpolate } from '../../../../i18n/interpolate';
import { classifyRetentionError } from './audioRetentionFailure';

/** host 聚合状态形状（src/host/services/infra/cacheRetentionStatus.ts 的 CacheRetentionStatus） */
export interface CacheRetentionStatus {
  lastSweepAt: number | null;
  deletedTotal: number;
  failedTotal: number;
  /** 此刻仍删不掉的失败数（UI 失败行只看这份，不随重试虚增） */
  failedCurrent: number;
  lastError?: string;
  /** 数据目录根（四类缓存目录都在它下面；「打开数据文件夹」出口用） */
  dataDir: string;
}

/** 失败行用到的文案键（zh/en 同构，真源在 i18n settings 的 data.cacheRetention 块） */
interface CacheRetentionFailureText {
  failedPermission: string;
  failedOther: string;
  openFolder: string;
  retry: string;
  details: string;
}

export const CacheRetentionFailureLine: React.FC<{
  failedCount: number;
  lastError?: string;
  dataDir: string;
  text: CacheRetentionFailureText;
  onRetry: () => void;
}> = ({ failedCount, lastError, dataDir, text, onRetry }) => {
  const handleOpenFolder = () => {
    // 打开失败只留痕不打断（fail-open 但不静默：错题本 2026-08-14）
    openNativePath(dataDir).catch((error) => {
      console.warn('cacheRetention: failed to open data folder', error);
    });
  };
  const main = interpolate(
    classifyRetentionError(lastError) === 'permission' ? text.failedPermission : text.failedOther,
    { count: failedCount },
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[11px] text-badge-danger shrink-0">
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
