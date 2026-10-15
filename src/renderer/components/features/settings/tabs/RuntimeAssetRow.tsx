// ============================================================================
// RuntimeAssetRow - 「本机功能」单个运行资产行（N-PY-RUNTIME-K2 rework r2）
//
// 从 UpdateSettings.tsx 抽出的展示组件：主行 = 名称 + 状态徽章 + 动作按钮，
// 全部 whitespace-nowrap + shrink-0（1440px 下不换行不竖排）；失败原因独占
// 主行下方一行，本地化文案为主、host 原始错误进 title 提示，logPath 存在时
// 提供「查看日志」动作。通用三件套（状态文案/显示名/tone）随行迁入，
// UpdateSettings.tsx 原样 re-export，测试导入面不变。
// ============================================================================

import React from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '../../../primitives';
import type { RuntimeAssetStatusEntry } from '@shared/contract';
import { getRuntimeAssetDisplayKind } from '@shared/contract';
import type { PythonEnvAssetRowDisplay } from './pythonEnvAssetRow';
import { zh } from '../../../../i18n/zh';

type UpdateSettingsText = typeof zh.settings.update;
const DEFAULT_RUNTIME_ASSETS_TEXT = zh.settings.update.runtimeAssets;

export function getRuntimeAssetStatusText(
  asset: RuntimeAssetStatusEntry,
  text: UpdateSettingsText['runtimeAssets']['status'] = DEFAULT_RUNTIME_ASSETS_TEXT.status,
): string {
  if (asset.state === 'installed') return text.available;
  if (asset.state === 'bundledFallback') return text.available;
  if (asset.state === 'unsupported') return text.unsupported;
  if (asset.delivery === 'optional') return text.firstUseDownload;
  return text.missing;
}

export function getRuntimeAssetDisplayName(
  asset: RuntimeAssetStatusEntry,
  text: UpdateSettingsText['runtimeAssets']['displayNames'] = DEFAULT_RUNTIME_ASSETS_TEXT.displayNames,
): string {
  const kind = getRuntimeAssetDisplayKind(asset);
  return kind ? text[kind] : asset.label;
}

function getRuntimeAssetTone(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return 'text-badge-success bg-green-500/10 border-badge-success/30';
  if (asset.state === 'bundledFallback') return 'text-badge-warning bg-amber-500/10 border-badge-warning/30';
  return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
}

export interface RuntimeAssetRowProps {
  asset: RuntimeAssetStatusEntry;
  /** python-env 行的安装中/失败态映射；非 python 资产传 null 走通用渲染 */
  pythonEnvRow: PythonEnvAssetRowDisplay | null;
  text: UpdateSettingsText['runtimeAssets'];
  /** 当前正在准备的资产 id（任一资产准备中时禁用所有准备按钮） */
  preparingAssetId: string | null;
  isPreparing: boolean;
  preparationPhase?: 'checking' | 'manifest' | 'downloading' | 'installing' | 'completed' | 'failed';
  preparationPercent?: number;
  /** 通用准备失败横幅已置位时按钮文案用「重试」 */
  forceRetryLabel: boolean;
  actionsDisabled: boolean;
  onPrepare: (assetId: string) => void;
  onOpenInstallLog: (logPath: string) => void;
}

export function RuntimeAssetRow({
  asset,
  pythonEnvRow,
  text,
  preparingAssetId,
  isPreparing,
  preparationPhase,
  preparationPercent,
  forceRetryLabel,
  actionsDisabled,
  onPrepare,
  onOpenInstallLog,
}: RuntimeAssetRowProps) {
  return (
    <div data-testid={`runtime-asset-row-${asset.id}`} className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-zinc-400 whitespace-nowrap shrink-0">
          {getRuntimeAssetDisplayName(asset, text.displayNames)}
        </span>
        <span
          className={`text-xs px-2 py-1 rounded border whitespace-nowrap shrink-0 ${pythonEnvRow?.tone ?? getRuntimeAssetTone(asset)}`}
        >
          {pythonEnvRow?.statusText ?? getRuntimeAssetStatusText(asset, text.status)}
        </span>
        {asset.delivery === 'optional' && asset.state === 'missing' && pythonEnvRow?.action !== 'hide' && (
          <Button
            disabled={actionsDisabled || Boolean(preparingAssetId)}
            onClick={() => onPrepare(asset.id)}
            variant="ghost"
            size="sm"
            className="whitespace-nowrap shrink-0"
            leftIcon={isPreparing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          >
            {isPreparing && preparationPhase === 'downloading' && preparationPercent !== undefined
              ? `${Math.round(preparationPercent)}%`
              : forceRetryLabel || pythonEnvRow?.action === 'retry' ? text.retryAsset : text.installAsset}
          </Button>
        )}
      </div>
      {pythonEnvRow?.failure && (
        <div className="flex items-center justify-end gap-2 max-w-[420px]">
          <span
            data-testid={`runtime-asset-failure-${asset.id}`}
            className="text-xs text-right leading-relaxed text-badge-warning"
            title={pythonEnvRow.failure.detail}
          >
            {pythonEnvRow.failure.reasonText}
          </span>
          {pythonEnvRow.failure.logPath && (
            <Button
              data-testid={`runtime-asset-open-log-${asset.id}`}
              variant="ghost"
              size="sm"
              className="whitespace-nowrap shrink-0"
              onClick={() => onOpenInstallLog(pythonEnvRow.failure?.logPath ?? '')}
            >
              {text.openInstallLog}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
