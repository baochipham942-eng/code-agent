import type {
  PrepareRuntimeAssetsResult,
  RuntimeAssetStatusEntry,
  RuntimeAssetsStatus,
  RuntimeAssetStatusState,
} from '../../../shared/contract/update';
import { PYTHON_ENV_ASSET_ID, PYTHON_ENV_LABEL } from './constants';
import { ensurePythonEnv } from './ensure';
import { installFailedError } from './errors';
import { getManagedPythonPath, getPythonEnvState } from './state';
import type { PythonEnvLookupOptions, PythonEnvPhase } from './types';

function toIpcState(phase: PythonEnvPhase): RuntimeAssetStatusState {
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

export function withPythonEnvStatus(
  status: RuntimeAssetsStatus,
  options: PythonEnvLookupOptions = {},
): RuntimeAssetsStatus {
  const state = getPythonEnvState(options);
  const pythonPath = getManagedPythonPath(options);
  const entry: RuntimeAssetStatusEntry = {
    id: PYTHON_ENV_ASSET_ID,
    label: PYTHON_ENV_LABEL,
    delivery: 'optional',
    state: toIpcState(state.phase),
    nodeModules: [],
  };
  if (pythonPath) {
    entry.files = [{
      name: 'python',
      path: pythonPath,
      exists: true,
      executable: true,
      source: 'managed',
    }];
    entry.activeRoot = state.root;
  }
  const assets = [...status.assets, entry];
  let preparation = status.preparation ?? null;
  if (state.phase === 'installing') {
    preparation = {
      assetId: PYTHON_ENV_ASSET_ID,
      phase: 'installing',
      percent: state.percent ?? 0,
    };
  } else if (state.phase === 'failed') {
    // code/logPath 一并透传：renderer 只拿 error 字符串时只能显示 host 英文原文，
    // 无法选本地化文案，也打不开错误信息里提到的安装日志。
    const failure = state.error ?? installFailedError(state.root);
    preparation = {
      assetId: PYTHON_ENV_ASSET_ID,
      phase: 'failed',
      error: failure.message,
      errorCode: failure.code,
      logPath: failure.logPath,
    };
  }
  return { ...status, assets, summary: summarize(assets), preparation };
}

export async function preparePythonEnvAsset(): Promise<PrepareRuntimeAssetsResult> {
  const result = await ensurePythonEnv();
  if (!result.ok) throw new Error(result.error.message);
  return {
    installed: [{
      assetId: PYTHON_ENV_ASSET_ID,
      root: result.root,
      reusedExistingInstall: result.reused,
    }],
    skipped: [],
  };
}
