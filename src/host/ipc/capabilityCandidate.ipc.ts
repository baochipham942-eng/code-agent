// ============================================================================
// 候选能力 IPC（N-CAP1 / F12）—— capabilityCandidate:* 通道
// ============================================================================
// 拉式：只有渲染层主动 list 才会读；host 侧不推事件、不发通知。
// 三个写操作只有两个（忽略 / 不再提示）——「做成能力」本期置灰，
// 所以这里**没有**任何起草、安装、执行入口，是有意的。

import type { IpcMain } from '../platform';
import { CAPABILITY_CANDIDATE_CHANNELS } from '../../shared/ipc/channels';
import type { CapabilityCandidateList } from '../../shared/contract/capabilityCandidate';
import { getCapabilityCandidateStore } from '../services/skills/capabilityCandidateStore';
import { listCandidates, setCandidateState } from '../services/skills/capabilityGapDetector';
import { fillMissingNames } from '../services/skills/capabilityCandidateNaming';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CapabilityCandidateIPC');

function readClusterKey(payload: unknown): string {
  const key = (payload as { clusterKey?: unknown } | null)?.clusterKey;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('clusterKey is required');
  }
  return key;
}

function buildList(): CapabilityCandidateList {
  const candidates = listCandidates(Date.now());
  return {
    candidates,
    foldedCount: candidates.filter((candidate) => !candidate.aboveFold).length,
  };
}

export function registerCapabilityCandidateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(CAPABILITY_CANDIDATE_CHANNELS.LIST, async (): Promise<CapabilityCandidateList> => {
    await getCapabilityCandidateStore().load();
    // 模型分是懒补的：首屏先出机械分排好的表（名字用工具组合兜底），
    // 补名字失败不影响这次返回，下次打开自然会再试。
    const before = buildList();
    const written = await fillMissingNames(before.candidates.filter((candidate) => candidate.aboveFold));
    return written > 0 ? buildList() : before;
  });

  ipcMain.handle(CAPABILITY_CANDIDATE_CHANNELS.IGNORE, async (_, payload: unknown) => {
    await getCapabilityCandidateStore().load();
    const ok = setCandidateState(readClusterKey(payload), 'ignored', Date.now());
    logger.debug('候选能力忽略', { ok });
    return { success: ok };
  });

  ipcMain.handle(CAPABILITY_CANDIDATE_CHANNELS.DISMISS, async (_, payload: unknown) => {
    await getCapabilityCandidateStore().load();
    const ok = setCandidateState(readClusterKey(payload), 'dismissed', Date.now());
    logger.debug('候选能力不再提示', { ok });
    return { success: ok };
  });
}
