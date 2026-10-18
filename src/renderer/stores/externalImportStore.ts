// ============================================================================
// External Import Store - 「从其他 AI 应用导入」来源检测状态（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 设置页侧栏入口与记忆页链接都按「检测到至少一个来源」显隐，导入页本身也要
// 展示检测明细。检测经 MEMORY 域 externalImportDetectSources（零写入）；这里
// 缓存结果并做在途去重，ensureChecked 幂等，refresh 供导入完成后强制重查。

import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ExternalImportDetectResult } from '@shared/contract/externalImport';
import ipcService from '../services/ipcService';

type ExternalImportDetectionStatus = 'idle' | 'checking' | 'available' | 'unavailable';

interface ExternalImportState {
  status: ExternalImportDetectionStatus;
  result: ExternalImportDetectResult | null;
  error: string | null;
  /** 幂等：已定论或查询中直接复用，不重复打 IPC */
  ensureChecked: () => Promise<void>;
  /** 强制重查（导入完成后刷新计数） */
  refresh: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

async function runDetection(
  set: (partial: Partial<Pick<ExternalImportState, 'status' | 'result' | 'error'>>) => void,
): Promise<void> {
  set({ status: 'checking', error: null });
  try {
    const result = await ipcService.invokeDomain<ExternalImportDetectResult>(
      IPC_DOMAINS.MEMORY,
      'externalImportDetectSources',
      {},
    );
    set({ status: result.anyDetected ? 'available' : 'unavailable', result });
  } catch (error) {
    set({
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const useExternalImportStore = create<ExternalImportState>((set, get) => ({
  status: 'idle',
  result: null,
  error: null,
  ensureChecked: async () => {
    if (get().status !== 'idle') return;
    if (!inflight) {
      inflight = runDetection(set).finally(() => {
        inflight = null;
      });
    }
    await inflight;
  },
  refresh: async () => {
    if (!inflight) {
      inflight = runDetection(set).finally(() => {
        inflight = null;
      });
    }
    await inflight;
  },
}));
