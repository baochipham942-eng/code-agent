// ============================================================================
// useContextHealthActions - ContextHealthPanel 的 navigate/unload/compact handlers
// 从 ContextPanel 抽出共享：右栏 ContextPanel 与 ContextUsagePill 的明细 modal
// 挂载同一个 ContextHealthPanel，handler 逻辑只维护一份。
// ============================================================================

import { useCallback } from 'react';
import { toast } from './useToast';
import { useI18n } from './useI18n';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSkillStore } from '../stores/skillStore';
import { useSessionStore } from '../stores/sessionStore';
import { useContextCompactionStore } from '../stores/contextCompactionStore';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { SourceTag } from '@shared/contract/contextHealth';

export interface ContextHealthActions {
  handleNavigate: (target: SourceTag) => void;
  handleUnload: (target: SourceTag) => Promise<void>;
  handleCompact: () => Promise<void>;
  isCompacting: boolean;
}

export function useContextHealthActions(): ContextHealthActions {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const setActiveWorkbenchTab = useAppStore((s) => s.setActiveWorkbenchTab);
  const setWorkbenchHighlight = useAppStore((s) => s.setWorkbenchHighlight);
  const unmountSkill = useSkillStore((s) => s.unmountSkill);
  const compactionStatus = useContextCompactionStore((s) => s.status);
  const startCompaction = useContextCompactionStore((s) => s.start);
  const succeedCompaction = useContextCompactionStore((s) => s.succeed);
  const failCompaction = useContextCompactionStore((s) => s.fail);

  // 跳转：切到对应面板 + 设置 highlight，让目标面板自己滚动 + 闪烁
  const handleNavigate = useCallback((target: SourceTag) => {
    switch (target.type) {
      case 'skill':
        openWorkbenchTab('skills');
        setActiveWorkbenchTab('skills');
        setWorkbenchHighlight({ kind: 'skill', name: target.name });
        break;
      case 'mcp':
        // MCP 当前没有独立面板，先切到 skills 并 hint
        openWorkbenchTab('skills');
        setActiveWorkbenchTab('skills');
        setWorkbenchHighlight({ kind: 'mcp', name: target.server });
        toast.info(ch.mcpNavigateToast.replace('{name}', target.server));
        break;
      case 'subagent':
        setWorkbenchHighlight({ kind: 'subagent', name: target.name });
        toast.info(ch.subagentNavigateToast.replace('{name}', target.name));
        break;
    }
  }, [ch, openWorkbenchTab, setActiveWorkbenchTab, setWorkbenchHighlight]);

  // 卸载：skill 调 store.unmountSkill；其他类型提示用户去对应入口
  const handleUnload = useCallback(async (target: SourceTag) => {
    switch (target.type) {
      case 'skill':
        try {
          await unmountSkill(target.name);
          toast.success(ch.unmountSkillSuccessToast.replace('{name}', target.name));
        } catch (err) {
          toast.error(ch.unmountFailedToast.replace('{message}', err instanceof Error ? err.message : ch.unknownError));
        }
        break;
      case 'mcp':
        try {
          await ipcService.invokeDomain(IPC_DOMAINS.MCP, 'setServerEnabled', {
            serverName: target.server,
            enabled: false,
          });
          toast.success(ch.disableMcpSuccessToast.replace('{name}', target.server));
        } catch (err) {
          toast.error(ch.disableFailedToast.replace('{message}', err instanceof Error ? err.message : ch.unknownError));
        }
        break;
      case 'subagent':
        toast.info(ch.subagentAutoRemoveToast);
        break;
    }
  }, [ch, unmountSkill]);

  // 与 ContextUsagePill.tsx 的 handleCompact 同一套路：useContextCompactionStore 单例
  // 守重入（'active' 直接 return），跟 pill 天然互斥，两处入口不会并发触发两次压缩。
  const handleCompact = useCallback(async () => {
    if (compactionStatus === 'active') return;
    const sessionId = useSessionStore.getState().currentSessionId;
    startCompaction();
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, sessionId ?? undefined);
      if (result.success) {
        succeedCompaction(result);
        if (sessionId) {
          void useSessionStore.getState().refreshContextHealth(sessionId);
        }
      } else {
        failCompaction(ch.compactFailed);
        toast.error(ch.compactFailedToast);
      }
    } catch {
      failCompaction(ch.compactFailed);
      toast.error(ch.compactFailedToast);
    }
  }, [ch, compactionStatus, failCompaction, startCompaction, succeedCompaction]);

  return {
    handleNavigate,
    handleUnload,
    handleCompact,
    isCompacting: compactionStatus === 'active',
  };
}
