// ============================================================================
// ProjectComposer —— 协作空间底部输入框。
// 视觉对齐主聊天 ChatInput（爸：「为什么不是和外面一样的」）：容器抄 composer-elevated
// 卡片（L1 底 + 投影 + 聚焦描边微亮，样式真源 global.css .composer-elevated）、多行
// textarea 观感（Enter 发送、Shift+Enter 换行）、发送按钮复用 ChatInput 的 SendButton
// 并放右下角。功能不对齐：模型选择器等底栏件不搬。
// 发送链路：createSession（workingDirectory=项目 workspacePath，host 侧 ensureProjectForWorkspace
// 按 workspace 自动挂 projectId）→ pendingProjectChatSeed → switchSession，
// ChatView 在目标会话就绪后自动发出首条消息。@neo 前缀原样透传，不特殊处理。
// ============================================================================

import React, { useRef, useState } from 'react';
import type { Project } from '@shared/contract/project';
import { useProjectChatSeedStore } from '../../../stores/projectChatSeedStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { SendButton } from '../chat/ChatInput/SendButton';

export interface ProjectComposerProps {
  project: Project | null;
}

const TITLE_MAX_LENGTH = 30;

export const ProjectComposer: React.FC<ProjectComposerProps> = ({ project }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // 中文输入法 composition 期间 Enter 是选词不是发送（与 ChatInput InputArea 同一处理）
  const isComposingRef = useRef(false);

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
      className="shrink-0 border-t border-zinc-800/70 px-6 py-3"
      data-testid="project-space-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      <div className="relative composer-elevated rounded-2xl">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !isComposingRef.current) {
              event.preventDefault();
              void handleSend();
            }
          }}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => {
            // 某些中文输入法（搜狗/百度）事件顺序: compositionEnd → keyDown
            setTimeout(() => { isComposingRef.current = false; }, 50);
          }}
          placeholder={ps.composerPlaceholder}
          disabled={sending}
          data-testid="project-space-composer-input"
          className="chat-composer-textarea w-full resize-none bg-transparent px-4 pb-10 pt-4 text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-500 focus:outline-hidden focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50 max-h-[200px]"
        />
        <div className="absolute bottom-3 right-3" data-testid="project-space-composer-send">
          <SendButton
            type="submit"
            hasContent={Boolean(text.trim())}
            disabled={sending}
            isInterrupting={sending}
          />
        </div>
      </div>
    </form>
  );
};
