// ============================================================================
// ProjectComposer —— 项目协作空间底部输入框。
// ChatInput（1103 行、重依赖会话作用域）判断为不可精简复用，按工单 fallback 单行输入+发送。
// 发送链路：createSession（workingDirectory=项目 workspacePath，host 侧 ensureProjectForWorkspace
// 按 workspace 自动挂 projectId）→ pendingProjectChatSeed → switchSession，
// ChatView 在目标会话就绪后自动发出首条消息。@neo 前缀原样透传，不特殊处理。
// ============================================================================

import React, { useState } from 'react';
import { SendHorizonal } from 'lucide-react';
import type { Project } from '@shared/contract/project';
import { useProjectChatSeedStore } from '../../../stores/projectChatSeedStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { Input } from '../../primitives/Input';
import { IconButton } from '../../primitives/IconButton';

export interface ProjectComposerProps {
  project: Project | null;
}

const TITLE_MAX_LENGTH = 30;

export const ProjectComposer: React.FC<ProjectComposerProps> = ({ project }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const title = content.length > TITLE_MAX_LENGTH ? content.slice(0, TITLE_MAX_LENGTH) : content;
      const session = await useSessionStore.getState().createSession(title, {
        workingDirectory: project?.workspacePath ?? undefined,
      });
      if (!session) return;
      useProjectChatSeedStore.getState().setPendingProjectChatSeed({ sessionId: session.id, content });
      // switchSession 会 closeSecondaryPages()，本页让位给新会话；ChatView 消费 seed 发出首条消息
      await useSessionStore.getState().switchSession(session.id);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex shrink-0 items-center gap-2 border-t border-zinc-800/70 px-6 py-3"
      data-testid="project-space-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={ps.composerPlaceholder}
        disabled={sending}
        data-testid="project-space-composer-input"
      />
      <IconButton
        type="submit"
        variant="active"
        icon={<SendHorizonal className="h-4 w-4" />}
        aria-label={ps.composerSend}
        title={ps.composerSend}
        loading={sending}
        disabled={sending || !text.trim()}
        data-testid="project-space-composer-send"
      />
    </form>
  );
};

