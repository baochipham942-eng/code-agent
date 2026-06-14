import { useEffect, useRef } from 'react';
import type { AgentEngineFailureDiagnostics, AgentEngineKind } from '@shared/contract/agentEngine';
import type { MessageAttachment } from '../../../../../shared/contract';
import { useSessionStore } from '../../../../stores/sessionStore';

interface ChatInputSessionScope {
  currentSessionId: string | null;
  /** 当前会话的 Agent Engine 类型（native / codex_cli / claude_code） */
  sessionEngineKind: AgentEngineKind;
  /** 外部 Agent Engine 最近一次失败，用于发送前可靠性提示。 */
  sessionEngineFailure?: AgentEngineFailureDiagnostics;
}

/**
 * ChatInput 的会话作用域状态：
 * - 暴露当前会话 id 和 engine 类型
 * - 会话切换时清空输入草稿和附件，避免上一个会话的内容残留到新会话
 */
export function useChatInputSessionScope(
  setValue: (value: string) => void,
  setAttachments: (attachments: MessageAttachment[]) => void,
): ChatInputSessionScope {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionEngineKind = useSessionStore((state) => {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    return session?.engine?.kind ?? 'native';
  });
  const sessionEngineFailure = useSessionStore((state) => {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    return session?.engine?.kind && session.engine.kind !== 'native'
      ? session.engine.failure
      : undefined;
  });

  // ref 防止首次挂载误清（只在 session id 实际变化时清空）
  const lastSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    if (lastSessionIdRef.current === currentSessionId) return;
    lastSessionIdRef.current = currentSessionId;
    setValue('');
    setAttachments([]);
  }, [currentSessionId, setValue, setAttachments]);

  return { currentSessionId, sessionEngineKind, sessionEngineFailure };
}
