// ============================================================================
// Run Command State - `!run` 卡的就地执行状态（N-IACT-RUN-EXEC-UI rework）
// ============================================================================
// 状态放模块级 store 而不是卡片组件 state：消息列表重渲染会让卡片 remount
// （2026-10-11 UI 验收实测：点击后 ~1.5s 状态被抹掉、审批「允许一次」之后
// completed/输出永远不出现），组件 state 一卸载就丢。IPC 发起与结果落地都
// 在 store 的 action 里，与组件生命周期解耦——remount 只换壳，running/
// completed/output 原样接回；没有任何卡片挂着时结果落地也不丢。
// 业主拍板 in-memory only：这里不接 persist 中间件、不落任何 storage，
// 页面刷新即全部清空。

import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

/** host 侧 runInteractiveCommand 的返回形状（src/host/app/interactiveRunCommand.ts） */
interface RunCommandResult {
  status: 'completed' | 'refused' | 'denied' | 'failed';
  output: string;
  exitCode?: number;
  reason?: string;
}

export type RunCommandPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'finished'; result: RunCommandResult };

const IDLE: RunCommandPhase = { kind: 'idle' };

/** IPC data 不可信（跨进程边界），按字段收窄，坏形状归 failed */
function normalizeRunResult(value: unknown): RunCommandResult {
  if (!value || typeof value !== 'object') {
    return { status: 'failed', output: '', reason: 'unexpected host response' };
  }
  const raw = value as Partial<RunCommandResult>;
  const status = raw.status === 'completed' || raw.status === 'refused'
    || raw.status === 'denied' || raw.status === 'failed' ? raw.status : 'failed';
  return {
    status,
    output: typeof raw.output === 'string' ? raw.output : '',
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

// key 用 JSON 组合而不是字符串拼接：command 里引号/中文/冒号什么都有，拼接有分隔符歧义
function runCardKey(messageId: string | undefined, command: string): string {
  return JSON.stringify([messageId ?? '', command]);
}

interface RunCommandState {
  entries: Record<string, RunCommandPhase>;
  start: (messageId: string | undefined, command: string, sessionId: string) => void;
  refuse: (messageId: string | undefined, command: string, reason: string) => void;
}

const useRunCommandStore = create<RunCommandState>()((set, get) => ({
  entries: {},
  start: (messageId, command, sessionId) => {
    const key = runCardKey(messageId, command);
    // running 守卫在 store 层：remount 换出来的新实例再点一次，也绝不能并发第二条 IPC
    if (get().entries[key]?.kind === 'running') return;
    set((state) => ({ entries: { ...state.entries, [key]: { kind: 'running' } } }));
    void (async () => {
      let phase: RunCommandPhase;
      try {
        const data = await ipcService.invokeDomain<RunCommandResult>(
          IPC_DOMAINS.AGENT,
          'runInteractiveCommand',
          { sessionId, command },
        );
        phase = { kind: 'finished', result: normalizeRunResult(data) };
      } catch (error) {
        // IPC 层拒绝（DomainInvokeError 等）按 failed 呈现，错误消息透传
        phase = {
          kind: 'finished',
          result: { status: 'failed', output: '', reason: error instanceof Error ? error.message : String(error) },
        };
      }
      set((state) => ({ entries: { ...state.entries, [key]: phase } }));
    })();
  },
  // 没有当前会话就没有审批链可挂：就地 refused（reason 由组件层 i18n 生成），不碰 IPC
  refuse: (messageId, command, reason) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [runCardKey(messageId, command)]: { kind: 'finished', result: { status: 'refused', output: '', reason } },
      },
    }));
  },
}));

/** 卡片订阅入口：没有条目（没点过 / 页面刷新后）就是 idle */
export function useRunCommandPhase(messageId: string | undefined, command: string): RunCommandPhase {
  return useRunCommandStore((state) => state.entries[runCardKey(messageId, command)]) ?? IDLE;
}

export function startRunCommand(messageId: string | undefined, command: string, sessionId: string): void {
  useRunCommandStore.getState().start(messageId, command, sessionId);
}

export function refuseRunCommand(messageId: string | undefined, command: string, reason: string): void {
  useRunCommandStore.getState().refuse(messageId, command, reason);
}
