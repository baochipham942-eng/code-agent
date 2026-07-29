// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpServerEditor,
  type McpServerConfig,
} from '../../../src/renderer/components/features/settings/McpServerEditor';

// JSON 视图只认连接配置字段。粘贴外部配置（MCP server README、别家客户端的配置文件）
// 时常带额外键，早先这些键被静默丢弃 —— 用户以为写进去的 enabled 生效了，实际没有。
// 这里钉住「必须当场说出忽略了哪些键」。

const renderEditor = (initialConfig: Partial<McpServerConfig>, onSave = vi.fn()) => {
  const result = render(
    <McpServerEditor isOpen onClose={vi.fn()} onSave={onSave} initialConfig={initialConfig} />,
  );
  return { ...result, onSave };
};

const switchToJson = () => {
  fireEvent.click(within(screen.getByRole('dialog')).getByText('JSON'));
};

const typeJson = (value: object) => {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: JSON.stringify(value, null, 2) } });
};

afterEach(() => cleanup());

describe('McpServerEditor JSON 视图的未知字段提示', () => {
  it('粘贴带 enabled 的配置时，明确说出该字段不会被保存', () => {
    renderEditor({ name: 'probe', type: 'stdio', command: 'npx' });
    switchToJson();
    typeJson({ name: 'probe', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true });

    const notice = screen.getByText(/以下字段不会被保存/);
    expect(notice.textContent).toContain('enabled');
  });

  it('多个未知字段全部列出，不只报第一个', () => {
    renderEditor({ name: 'probe', type: 'stdio', command: 'npx' });
    switchToJson();
    typeJson({ name: 'probe', type: 'stdio', command: 'npx', enabled: true, lazyLoad: false, timeout: 30 });

    const notice = screen.getByText(/以下字段不会被保存/);
    expect(notice.textContent).toContain('enabled');
    expect(notice.textContent).toContain('lazyLoad');
    expect(notice.textContent).toContain('timeout');
  });

  it('只写受支持字段时不提示（不制造噪音）', () => {
    renderEditor({ name: 'probe', type: 'stdio', command: 'npx' });
    switchToJson();
    typeJson({ name: 'probe', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });

    expect(screen.queryByText(/以下字段不会被保存/)).toBeNull();
  });

  it('JSON 还没写完（解析失败）时不提示未知字段', () => {
    renderEditor({ name: 'probe', type: 'stdio', command: 'npx' });
    switchToJson();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{ "name": "probe", "enabled": ' } });

    expect(screen.queryByText(/以下字段不会被保存/)).toBeNull();
  });
});
