// ============================================================================
// pythonEnvAssetRow - 「本机功能」python-env 行的展示态映射（N-PY-RUNTIME-K2）
//
// asset.state 只表达 installed/missing/unsupported；安装中与失败态来自
// preparation（K1 状态机经 withPythonEnvStatus 附在 IPC 状态上）。映射集中在
// 这个纯函数里，不进 UpdateSettings.tsx（god-file 限行）。非 python 资产返回
// null，落回通用渲染路径。
// ============================================================================

import type {
  RuntimeAssetPreparationStatus,
  RuntimeAssetStatusEntry,
} from '@shared/contract';
import { getRuntimeAssetDisplayKind } from '@shared/contract/update';
import { zh } from '../../../../i18n/zh';

type UpdateSettingsText = typeof zh.settings.update;
const DEFAULT_RUNTIME_ASSETS_TEXT = zh.settings.update.runtimeAssets;

/** python-env 行的动作区：hide = 安装中不显示按钮；retry = 失败显示「重试」。 */
export interface PythonEnvAssetRowDisplay {
  statusText: string;
  tone: string;
  failureReason?: string;
  action: 'hide' | 'retry' | 'default';
}

export function getPythonEnvAssetRowDisplay(
  asset: Pick<RuntimeAssetStatusEntry, 'id' | 'label' | 'state'>,
  preparation: RuntimeAssetPreparationStatus | null,
  text: UpdateSettingsText['runtimeAssets'] = DEFAULT_RUNTIME_ASSETS_TEXT,
): PythonEnvAssetRowDisplay | null {
  if (getRuntimeAssetDisplayKind(asset) !== 'pythonEnv') return null;

  if (preparation?.phase === 'installing') {
    const percent = preparation.percent !== undefined ? Math.round(preparation.percent) : null;
    return {
      statusText: percent !== null ? `${text.status.installing} ${percent}%` : text.status.installing,
      tone: 'text-badge-warning bg-amber-500/10 border-badge-warning/30',
      action: 'hide',
    };
  }
  if (preparation?.phase === 'failed') {
    return {
      statusText: text.status.installFailed,
      tone: 'text-badge-warning bg-amber-500/10 border-badge-warning/30',
      failureReason: preparation.error,
      action: 'retry',
    };
  }
  if (asset.state === 'installed') {
    return {
      statusText: text.status.available,
      tone: 'text-badge-success bg-green-500/10 border-badge-success/30',
      action: 'default',
    };
  }
  if (asset.state === 'unsupported') {
    return {
      statusText: text.status.unsupported,
      tone: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60',
      action: 'default',
    };
  }
  return {
    statusText: text.status.firstUseDownload,
    tone: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60',
    action: 'default',
  };
}
