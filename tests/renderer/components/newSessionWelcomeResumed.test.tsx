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

describe('空态首屏：真新会话给欢迎页，恢复的历史会话写明身份', () => {
  afterEach(() => cleanup());

  it('真新会话渲染欢迎页', () => {
    render(<NewSessionWelcome onSend={vi.fn()} />);
    expect(screen.getByTestId('chat-welcome-title').textContent).toBe('想完成什么？');
  });

  it('恢复的空历史会话把会话标题写在首屏，不再伪装成欢迎页', () => {
    render(
      <NewSessionWelcome
        onSend={vi.fn()}
        resumedSession={{ title: '你好', updatedAt: Date.now() - 9 * 60 * 60 * 1000 }}
      />,
    );
    const title = screen.getByTestId('chat-welcome-title').textContent ?? '';
    expect(title).toContain('你好');
    expect(title).not.toBe('想完成什么？');
    // 用户得知道「在这里发消息 = 接着旧会话」，以及怎么真开一条新的
    expect(screen.getByText(/新任务/)).toBeTruthy();
  });
});
