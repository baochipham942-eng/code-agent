// ============================================================================
// ProjectComposer —— 协作空间底部输入框。
// 直接复用主聊天 ChatInput 完整件（爸 2026-07-30 拍板「把外面的完整输入框搬进来或用同一个」）。
// sessionless 模式 = 主界面新会话草稿同款语义：会话绑定的部件（/loop、记忆开关、资料库 pin、
// 实时通话）按既有草稿态逻辑降级提示，不会绑到项目页背后那个会话上发错配置。
// 发送链路：onSend(envelope) 内 createSession（workingDirectory=项目 workspacePath，host 侧
// ensureProjectForWorkspace 按 workspace 自动挂 projectId）→ 乐观上屏首条用户消息
// （落地即进行中态：切进会话那一刻消息已在时间线上，不再先 stare 几秒空态）
// → pendingProjectChatSeed（完整 envelope，clientMessageId 与乐观消息同 id）
// → switchSession，ChatView 消费 seed 把 envelope 真正发给 agent（sendMessage 按 id 去重
// 不双份）；发送失败 ChatView 侧回滚乐观消息。@neo 前缀原样透传，不特殊处理。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { Message } from '@shared/contract';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { Project } from '@shared/contract/project';
import { generateMessageId } from '@shared/utils/id';
import { useComposerStore, spaceScopeKey } from '../../../stores/composerStore';
import { useProjectChatSeedStore } from '../../../stores/projectChatSeedStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { ChatInput } from '../chat/ChatInput';

export interface ProjectComposerProps {
  project: Project | null;
}

const TITLE_MAX_LENGTH = 30;

export const ProjectComposer: React.FC<ProjectComposerProps> = ({ project }) => {
  const [sending, setSending] = useState(false);

  // 进入空间页 = 激活 space 槽：会话里配置的 skill/pin/专家不得漏进来；
  // 离开时 activateScope 会把空间配置快照回去，回会话可还原。
  useEffect(() => {
    useComposerStore.getState().activateScope(spaceScopeKey(project?.id), {
      workingDirectory: project?.workspacePath ?? null,
    });
  }, [project?.id, project?.workspacePath]);

  const handleSend = useCallback(async (envelope: ConversationEnvelope): Promise<boolean> => {
    const content = envelope.content.trim();
    if (!content && !(envelope.attachments?.length)) return false;
    if (sending) return false;
    setSending(true);
    try {
      const titleSource = content || envelope.attachments?.[0]?.name || '';
      const title = titleSource.length > TITLE_MAX_LENGTH ? titleSource.slice(0, TITLE_MAX_LENGTH) : titleSource;
      // createSession 内 handoffActiveScopeToSession：space 槽 → 新会话槽 + pin 物化 + 专家 bind
      const session = await useSessionStore.getState().createSession(title || undefined, {
        workingDirectory: project?.workspacePath ?? undefined,
      });
      if (!session) return false;
      // 乐观上屏：createSession 已把 currentSessionId 切到新会话，消息直接进它的时间线。
      const userMessage: Message = {
        id: envelope.clientMessageId ?? generateMessageId(),
        role: 'user',
        content: envelope.content,
        timestamp: Date.now(),
        ...(envelope.attachments?.length ? { attachments: envelope.attachments } : {}),
      };
      useSessionStore.getState().addMessage(userMessage);
      useProjectChatSeedStore.getState().setPendingProjectChatSeed({
        sessionId: session.id,
        envelope: { ...envelope, clientMessageId: userMessage.id },
      });
      // switchSession 会 closeSecondaryPages()，本页让位给新会话；ChatView 消费 seed 发出首条消息
      await useSessionStore.getState().switchSession(session.id);
      return true;
    } finally {
      setSending(false);
    }
  }, [project?.workspacePath, sending]);

  return (
    <div className="shrink-0 border-t border-zinc-800/70" data-testid="project-space-composer">
      <ChatInput
        onSend={handleSend}
        disabled={sending}
        sessionless
        scopeProjectId={project?.id ?? null}
      />
    </div>
  );
};
