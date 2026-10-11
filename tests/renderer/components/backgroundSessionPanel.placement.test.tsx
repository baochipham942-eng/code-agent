// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 放置/几何契约（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// 无槽验收实测：展开的后台面板（fixed bottom-4 right-4, 320×160）盖住发送键/模型切换/
// 上下文表——elementFromPoint(发送键中心) = 面板本体。rework 后面板是 ChatView 列内、
// composer 正上方的文档流块，参与布局，几何上不可能再压 composer。这里钉死三件事：
//   1. 面板 root 不得回退到 fixed/absolute 浮层（那正是当初盖住 composer 的形态）；
//   2. 挂载点必须在 ChatView 列内、<ChatInput 之前，App.tsx 不再全局挂载
//      （源码结构断言，primaryActionConvergence.test.ts 同款手法）。
// 面板压在模态遮罩之下的层级契约在 backgroundSessionPanel.zLayer.test.tsx（与
// origin/main 同名同意图）；真实窗口内的 elementFromPoint 几何由真机无槽验证覆盖。

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const RENDERER_SRC = path.resolve(__dirname, '../../../src/renderer');

function readRendererSource(rel: string): string {
  return readFileSync(path.join(RENDERER_SRC, rel), 'utf8');
}

describe('BackgroundSessionPanel 放置（不压 composer）', () => {
  beforeEach(() => {
    useSessionStore.setState({
      backgroundSessions: [
        {
          sessionId: 's1',
          title: '后台任务一',
          startedAt: Date.now(),
          backgroundedAt: Date.now(),
          status: 'running',
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
  });

  it('展开态 root 不用 fixed/absolute 浮层定位（列内文档流块）', () => {
    render(<BackgroundSessionPanel />);
    const root = screen.getByTestId('background-session-panel');
    expect(root.classList.contains('fixed')).toBe(false);
    expect(root.classList.contains('absolute')).toBe(false);
    expect(root.style.position).not.toBe('fixed');
    expect(root.style.position).not.toBe('absolute');
  });

  it('收起态胶囊同样不用 fixed/absolute 浮层定位', () => {
    render(<BackgroundSessionPanel />);
    fireEvent.click(screen.getByRole('button', { name: '收起后台任务面板' }));
    const capsule = screen.getByTestId('background-session-panel-collapsed');
    expect(capsule.classList.contains('fixed')).toBe(false);
    expect(capsule.classList.contains('absolute')).toBe(false);
  });

  it('挂载在 ChatView 列内 <ChatInput 之前；App.tsx 不再全局挂载（源码结构）', () => {
    const chatView = readRendererSource('components/ChatView.tsx');
    const panelAt = chatView.indexOf('<BackgroundSessionPanel />');
    const composerAt = chatView.indexOf('<ChatInput ');
    expect(panelAt).toBeGreaterThanOrEqual(0);
    expect(composerAt).toBeGreaterThan(panelAt);

    const app = readRendererSource('App.tsx');
    expect(app.includes('BackgroundSessionPanel')).toBe(false);
  });
});
