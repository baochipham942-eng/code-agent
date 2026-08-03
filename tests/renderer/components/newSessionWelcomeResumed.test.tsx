// @vitest-environment jsdom
// ============================================================================
// 空态首屏消歧（2026-08-01 事故）：冷启动自动恢复的历史会话若没有内容，首屏与真新
// 会话像素级不可区分，用户以为自己新开了一条，首条消息却接进了旧会话。欢迎页只能
// 对真·新会话出现；恢复到历史会话时必须把是哪条写在脸上。
// ============================================================================

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewSessionWelcome } from '../../../src/renderer/components/features/chat/NewSessionWelcome';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '新对话',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: Date.now() - 9 * 60 * 60 * 1000,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  } as SessionWithMeta;
}

const WELCOME_TITLE = '这次想去哪颗星球？';

describe('空态首屏：真新会话给欢迎页，恢复的历史会话写明身份', () => {
  afterEach(() => cleanup());

  it('没有会话信息时按真新会话渲染欢迎页', () => {
    render(<NewSessionWelcome onSend={vi.fn()} />);
    expect(screen.getByTestId('chat-welcome-title').textContent).toBe(WELCOME_TITLE);
  });

  it('真·新会话（默认标题 + 零消息）渲染欢迎页', () => {
    render(<NewSessionWelcome onSend={vi.fn()} session={session({})} />);
    expect(screen.getByTestId('chat-welcome-title').textContent).toBe(WELCOME_TITLE);
  });

  it('恢复的空历史会话把会话标题写在首屏，不再伪装成欢迎页', () => {
    // 事故形状：0 消息，却带着旧标题
    render(<NewSessionWelcome onSend={vi.fn()} session={session({ title: '你好' })} />);

    const title = screen.getByTestId('chat-welcome-title').textContent ?? '';
    expect(title).toContain('你好');
    expect(title).not.toBe(WELCOME_TITLE);
    // 用户得知道「在这里发消息 = 接着旧会话」，以及怎么真开一条新的
    expect(screen.getByText(/新任务/)).toBeTruthy();
  });

  it('有内容的会话（即便标题是默认的）同样不算新会话', () => {
    render(<NewSessionWelcome onSend={vi.fn()} session={session({ messageCount: 3 })} />);
    expect(screen.getByTestId('chat-welcome-title').textContent).not.toBe(WELCOME_TITLE);
  });

  it('品牌区：42px 慢转地球单独作主视觉，不与品牌标并排（2026-08-02 修订：双标并置生硬）', () => {
    const { container } = render(<NewSessionWelcome onSend={vi.fn()} />);
    const planet = container.querySelector('[data-planet="earth"]') as HTMLElement | null;
    expect(planet).toBeTruthy();
    expect(planet?.style.width).toBe('42px');
    expect(screen.queryByTestId('neo-brand-mark')).toBeNull();
  });
});
