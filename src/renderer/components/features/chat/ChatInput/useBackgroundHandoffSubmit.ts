// ============================================================================
// useBackgroundHandoffSubmit - 运行中 composer 的第三个显式动作
// ============================================================================
//
// RQ-060（owner decision 10-09，option B）：任务运行中 composer 默认 Enter 排队、
// Cmd/Ctrl+Enter 改道；这里补显式入口「转后台继续聊」——把当前会话交给既有
// BackgroundTaskManager（IPC BACKGROUND_MOVE_TO_BACKGROUND，与侧栏菜单/快捷键同一条链路），
// 再开一个新前台会话，把草稿按普通发送管线发出去（含附件）。默认两条路径零改动。

import { useCallback } from 'react';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { useSessionStore } from '../../../../stores/sessionStore';

/** 提交选项（useChatInputSubmit 的 opts 子集；toBackground 走普通发送，不带 steer/content）。 */
interface BackgroundHandoffSubmitOptions {
  steer?: boolean;
  content?: string;
  toBackground?: boolean;
}

export interface UseBackgroundHandoffSubmitParams {
  currentSessionId: string | null;
  handleSubmit: (e?: undefined, opts?: BackgroundHandoffSubmitOptions) => void | Promise<void>;
}

export function useBackgroundHandoffSubmit(params: UseBackgroundHandoffSubmitParams) {
  const { t } = useI18n();
  const { currentSessionId, handleSubmit } = params;
  return useCallback(async () => {
    if (!currentSessionId) return;
    const sessionStore = useSessionStore.getState();
    // 1. 当前任务转后台（复用既有 IPC；失败保留草稿并出声，绝不让这句话消失）
    const moved = await sessionStore.moveToBackground(currentSessionId);
    if (!moved) {
      toast.error(t.chatInput.backgroundHandoffMoveFailed);
      return;
    }
    // 2. 开新前台会话。await 完成：发送按最新 currentSessionId 绑定目标会话，
    //    不依赖「进行中建会话竞态」的 pending-create 兜底。
    const created = await sessionStore.createSession('新对话');
    if (!created) {
      toast.error(t.chatInput.backgroundHandoffCreateFailed);
      return;
    }
    // 3. 草稿走普通发送管线（toBackground：跳过排队/改道分流，envelope 不带 runtimeInput 模式）
    await handleSubmit(undefined, { toBackground: true });
  }, [currentSessionId, handleSubmit, t]);
}
