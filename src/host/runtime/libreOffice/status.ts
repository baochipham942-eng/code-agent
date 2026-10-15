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
  // Shared preparation has one owner: an installing/failed LibreOffice install wins
  // over Python or update-service preparation; otherwise preserve the existing owner.
  const ownPreparation = libreOfficePreparation(state);
  return {
    ...status,
    assets,
    summary: summarize(assets),
    preparation: ownPreparation ?? status.preparation ?? null,
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
