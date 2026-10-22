import type {
  PrepareRuntimeAssetsResult,
  RuntimeAssetStatusEntry,
  RuntimeAssetsStatus,
  RuntimeAssetStatusState,
} from '../../../shared/contract/update';
import { LIBREOFFICE_RUNTIME_ASSET_ID, LIBREOFFICE_RUNTIME_LABEL } from './constants';
import { ensureLibreOffice } from './ensure';
import { installFailedError } from './errors';
import { getLibreOfficeState } from './state';
import { managedLibreOfficePath } from './layout';
import type { LibreOfficeLookupOptions, LibreOfficePhase } from './types';

function toIpcState(phase: LibreOfficePhase): RuntimeAssetStatusState {
  if (phase === 'installed') return 'installed';
  if (phase === 'unsupported') return 'unsupported';
  return 'missing';
}

function summarize(assets: RuntimeAssetStatusEntry[]): RuntimeAssetsStatus['summary'] {
  return {
    installed: assets.filter((asset) => asset.state === 'installed').length,
    bundledFallback: assets.filter((asset) => asset.state === 'bundledFallback').length,
    missing: assets.filter((asset) => asset.state === 'missing').length,
    unsupported: assets.filter((asset) => asset.state === 'unsupported').length,
  };
}

function libreOfficePreparation(
  state: ReturnType<typeof getLibreOfficeState>,
): RuntimeAssetsStatus['preparation'] {
  if (state.phase === 'installing') {
    return { assetId: LIBREOFFICE_RUNTIME_ASSET_ID, phase: 'installing', percent: state.percent ?? 0 };
  }
  if (state.phase === 'failed') {
    const error = state.error ?? installFailedError(state.root);
    return {
      assetId: LIBREOFFICE_RUNTIME_ASSET_ID,
      phase: 'failed',
      error: error.message,
      errorCode: error.code,
      logPath: error.logPath,
    };
  }
  return null;
}

/** preparation 的「在装」相位：downloading/installing 都算安装进行中。 */
function isInProgress(preparation: NonNullable<RuntimeAssetsStatus['preparation']>): boolean {
  return preparation.phase === 'installing' || preparation.phase === 'downloading';
}

/**
 * 共享 preparation 字段的合并规则（本函数在 IPC 链路里最后应用，排在 python-env 之后）：
 * 安装进行中（installing/downloading）压过 failed——失败只在没有资产在装时可见，
 * 否则 python 行的安装进度会被 LibreOffice 自动安装留下的终态失败盖掉。
 * 两侧同为在装或同为 failed 时，后应用者（LibreOffice）持有；否则保留已有持有者。
 */
function mergePreparation(
  own: RuntimeAssetsStatus['preparation'],
  existing: RuntimeAssetsStatus['preparation'],
): RuntimeAssetsStatus['preparation'] {
  if (!own) return existing ?? null;
  if (!existing) return own;
  if (isInProgress(own)) return own;
  if (isInProgress(existing)) return existing;
  return own;
}

export function withLibreOfficeStatus(
  status: RuntimeAssetsStatus,
  options: LibreOfficeLookupOptions = {},
): RuntimeAssetsStatus {
  const state = getLibreOfficeState(options);
  const entry: RuntimeAssetStatusEntry = {
    id: LIBREOFFICE_RUNTIME_ASSET_ID,
    label: LIBREOFFICE_RUNTIME_LABEL,
    delivery: 'optional',
    state: toIpcState(state.phase),
    nodeModules: [],
  };
  if (state.sofficePath) {
    entry.files = [{
      name: 'soffice',
      path: state.sofficePath,
      exists: true,
      executable: true,
      source: state.sofficePath === managedLibreOfficePath(state.root) ? 'managed' : 'dev',
    }];
    if (state.phase === 'installed' && state.sofficePath.startsWith(state.root)) entry.activeRoot = state.root;
  }
  const assets = [...status.assets.filter((asset) => asset.id !== LIBREOFFICE_RUNTIME_ASSET_ID), entry];
  const ownPreparation = libreOfficePreparation(state);
  return {
    ...status,
    assets,
    summary: summarize(assets),
    preparation: mergePreparation(ownPreparation, status.preparation ?? null),
  };
}

export async function prepareLibreOfficeAsset(): Promise<PrepareRuntimeAssetsResult> {
  const result = await ensureLibreOffice();
  if (!result.ok) throw new Error(result.error.message);
  return {
    installed: [{
      assetId: LIBREOFFICE_RUNTIME_ASSET_ID,
      root: result.root,
      reusedExistingInstall: result.reused,
    }],
    skipped: [],
  };
}
