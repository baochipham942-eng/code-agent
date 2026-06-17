import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 静态渲染下 effect 不跑（checkpoints 维持空），mock store + ipcService 让模块可导入。
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({ currentSessionId: 'sess-1' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: async () => [] },
}));

import { RewindPanel } from '../../../src/renderer/components/RewindPanel';

// 验证 RewindPanel 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('RewindPanel (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    const html = renderToStaticMarkup(<RewindPanel isOpen={false} onClose={() => {}} />);
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/空态/footer 齐全', () => {
    const html = renderToStaticMarkup(<RewindPanel isOpen={true} onClose={() => {}} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Rewind to Checkpoint');
    expect(html).toContain('No checkpoints available');
    expect(html).toContain('Cancel');
    expect(html).toContain('Rewind');
  });
});
