// @vitest-environment jsdom
// N-FIX-EMPTY-ASSISTANT-REPLY-NO-NOTICE：重载历史里「空正文 + agentError」与「只剩中断标记」
// 两种助手行，用户必须看到人话（错误卡 + 重试 / 本地化的“已停止”），不能是空白气泡或括号英文。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract';

let lang: 'zh' | 'en' = 'zh';
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang === 'zh' ? zh : en, language: lang }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = { developerMode: false, processingSessionIds: new Set<string>(), pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {}, openPreview: vi.fn() };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) => selector({ currentSessionId: 'session-1', runningSessionIds: new Set<string>() }),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (s: { tasks: never[] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({ useAgentTreeSnapshot: () => ({ snapshot: null }) }));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({ isSemanticToolUIEnabled: () => false }));

import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

afterEach(cleanup);

function renderHistory(messages: Message[]): string {
  const nodes = projectTurns(messages, 'session-1', false).turns.flatMap((t) => t.nodes);
  render(<>{nodes.map((n, i) => <TraceNodeRenderer key={i} node={n} sessionId="session-1" />)}</>);
  return document.body.textContent ?? '';
}

const user = (id: string, timestamp = 1): Message => ({ id, role: 'user', content: '只回答两个字：收到', timestamp });
const failed = (id: string, ts: number): Message => ({
  id, role: 'assistant', content: '', timestamp: ts,
  metadata: { agentError: { category: 'generic', code: 'RUN_FAILED', rawMessage: '您已达到每周/每月使用上限', timestamp: ts } },
});
const cancelledOnly: Message = { id: 'a-c', role: 'assistant', content: '\n\n[cancelled]', timestamp: 2 };
const switchedOnly: Message = { id: 'a-s', role: 'assistant', content: '\n\n[未完成 — 切换会话中断]', timestamp: 2 };

describe.each(['zh', 'en'] as const)('空回复行呈现 (%s)', (language) => {
  it('(a) 空正文 + agentError：渲染错误卡与重试，不是空白', async () => {
    lang = language;
    const text = renderHistory([user('u1'), failed('a1', 2)]);
    const { zh } = await import('../../../src/renderer/i18n/zh');
    const { en } = await import('../../../src/renderer/i18n/en');
    const t = language === 'zh' ? zh : en;
    console.log(`[${language}] (a) DOM text:`, JSON.stringify(text));
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain(t.agentError.actions.retry);
  });

  it('(a2) 连续三轮失败：同因折叠，最多一张整卡', () => {
    lang = language;
    renderHistory([user('u1'), failed('a1', 2), user('u2'), failed('a2', 4), user('u3'), failed('a3', 6)]);
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /重试|Retry/i.test(b.textContent ?? ''));
    console.log(`[${language}] (a2) retry buttons:`, buttons.length);
    expect(buttons.length).toBeLessThanOrEqual(1);
  });

  it.each([['[cancelled]', cancelledOnly], ['[未完成 — 切换会话中断]', switchedOnly]] as const)('(b) 只有 %s 的助手行：不空白、不露括号原文', (marker, row) => {
    lang = language;
    const text = renderHistory([user('u1'), row]);
    console.log(`[${language}] (b) ${marker} DOM text:`, JSON.stringify(text));
    expect(text).not.toContain('[cancelled]');
    expect(text).not.toContain('切换会话中断]');
    expect(text.replace('只回答两个字：收到', '').trim().length).toBeGreaterThan(0);
  });

  it('早先 turn 的 recovery 不会吃掉后续 turn 的 [cancelled] 说明', async () => {
    lang = language;
    renderHistory([
      user('u-old'),
      {
        id: 'a-recovery',
        role: 'assistant',
        content: '早先轮次的部分回答',
        timestamp: 2,
        metadata: { streamRecovery: { turnId: 'turn-old' }, streamInterruptionReason: 'app-restart' },
      },
      user('u-later', 3),
      { ...cancelledOnly, id: 'a-later-cancelled', timestamp: 4 },
    ]);
    const { zh } = await import('../../../src/renderer/i18n/zh');
    const { en } = await import('../../../src/renderer/i18n/en');
    const t = language === 'zh' ? zh : en;
    const notes = Array.from(document.querySelectorAll('[data-testid="bare-interruption-note"]'));
    console.log(`[${language}] multi-turn bare notes:`, JSON.stringify(notes.map((node) => node.textContent)));
    expect(notes.map((node) => node.textContent)).toContain(
      t.outcomeWords['cancelled-by-user'].timeline.reason,
    );
    expect(document.body.textContent).not.toContain('[cancelled]');
  });
});
