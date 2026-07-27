import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// G2 拍板形态：AskUserQuestion 从全局 Modal 换成 ChatView 内打断式选项卡
// （遮盖 composer）。App 只负责入队（无 sessionId 绑当前会话），
// 卡片自身在回答/跳过成功后出队。
describe('App/ChatView user question wiring（G2 打断式选项卡）', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const chatViewSource = readFileSync(resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'), 'utf8');

  it('App 收到问题入 pending 队列，不再挂全局 Modal', () => {
    expect(appSource).toContain('useSessionStore.getState().addPendingUserQuestion(withSession)');
    expect(appSource).not.toContain('UserQuestionModal');
  });

  it('ChatView 有待答问题时渲染打断式选项卡并遮盖 composer', () => {
    expect(chatViewSource).toContain('<UserQuestionCard request={pendingUserQuestion} />');
    expect(chatViewSource).toContain("pendingUserQuestion ? 'hidden' : undefined");
  });

  it('卡片回答/跳过成功后自己出队', () => {
    const cardSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/UserQuestionCard.tsx'),
      'utf8',
    );
    expect(cardSource).toContain('useSessionStore.getState().clearPendingUserQuestion(request)');
  });
});
