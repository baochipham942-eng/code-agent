// ============================================================================
// 批C2：目录选择并入新任务流程——欢迎页目录 chip 契约
//   1. 未设目录也有入口（引导态「选择目录」）——侧栏「选择目录」行退役后这是唯一常驻入口
//   2. 已设目录显示项目名、仍可点
//   3. tooltip 不回显完整路径（内部路径泄漏是本批要修的缺陷）
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionWelcome } from '../../../src/renderer/components/features/chat/NewSessionWelcome';

describe('NewSessionWelcome 目录 chip（批C2）', () => {
  it('未设目录时渲染引导态入口', () => {
    const html = renderToStaticMarkup(
      <NewSessionWelcome onSend={vi.fn()} workingDirectory={null} onPickDirectory={vi.fn()} />,
    );
    expect(html).toContain('welcome-directory-chip');
    expect(html).toContain('选择目录');
  });

  it('已设目录时显示项目名，tooltip 不含完整路径', () => {
    const dir = '/Users/someone/.code-agent-dev/work';
    const html = renderToStaticMarkup(
      <NewSessionWelcome onSend={vi.fn()} workingDirectory={dir} onPickDirectory={vi.fn()} />,
    );
    expect(html).toContain('welcome-directory-chip');
    expect(html).toContain('work');
    expect(html).not.toContain('/Users/someone');
    expect(html).not.toContain('.code-agent-dev');
  });

  it('未传 onPickDirectory 且无目录时不渲染 chip（向后兼容只读形态）', () => {
    const html = renderToStaticMarkup(
      <NewSessionWelcome onSend={vi.fn()} workingDirectory={null} />,
    );
    expect(html).not.toContain('welcome-directory-chip');
  });
});
