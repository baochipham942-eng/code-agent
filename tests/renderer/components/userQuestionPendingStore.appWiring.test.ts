import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// AskUserQuestion 从全局 Modal 换成 ChatView 的 DecisionSlot 卡片。
// App 只负责入队（无 sessionId 绑当前会话），
// 卡片自身在回答/跳过成功后出队。
describe('App/ChatView user question wiring（G2 打断式选项卡）', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const chatViewSource = readFileSync(resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'), 'utf8');

  it('App 收到问题入 pending 队列，不再挂全局 Modal', () => {
    expect(appSource).toContain('useSessionStore.getState().addPendingUserQuestion(withSession)');
    expect(appSource).not.toContain('UserQuestionModal');
  });

  it('ChatView 把提问/计划交给 DecisionSlot，composer 始终常显', () => {
    expect(chatViewSource).toContain('userQuestion={pendingUserQuestion}');
    expect(chatViewSource).toContain('planApproval={pendingPlanApproval}');
    expect(chatViewSource).toContain('<ChatInput');
    expect(chatViewSource).not.toContain("pendingUserQuestion || pendingPlanApproval ? 'hidden' : undefined");
  });

  it('pending 队列空值使用稳定引用，避免 Zustand snapshot 无限重渲染', () => {
    expect(chatViewSource).toContain('const EMPTY_PENDING_USER_QUESTIONS: UserQuestionRequest[] = [];');
    expect(chatViewSource).toContain('?? EMPTY_PENDING_USER_QUESTIONS');
    expect(chatViewSource).not.toContain('pendingUserQuestionsBySessionId?.get(currentSessionId) ?? []');
  });

  it('卡片回答/跳过成功后自己出队', () => {
    const cardSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/UserQuestionCard.tsx'),
      'utf8',
    );
    expect(cardSource).toContain('useSessionStore.getState().clearPendingUserQuestion(request)');
  });
});
