import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExportModal } from '../../../src/renderer/components/features/export/ExportModal';

// 验证 ExportModal 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('ExportModal (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    const html = renderToStaticMarkup(
      <ExportModal
        isOpen={false}
        onClose={() => {}}
        sessionId="s1"
        sessionTitle="会话标题"
        messages={[]}
      />
    );
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/格式选项/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <ExportModal
        isOpen={true}
        onClose={() => {}}
        sessionId="s1"
        sessionTitle="会话标题"
        messages={[]}
      />
    );

    // Modal primitive 提供的无障碍契约（手搓版本没有）
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');

    // 标题与会话信息
    expect(html).toContain('导出会话');
    expect(html).toContain('会话标题');

    // 两种导出格式选项保留
    expect(html).toContain('Markdown');
    expect(html).toContain('JSON');

    // footer 动作走 Button primitive
    expect(html).toContain('复制内容');
    expect(html).toContain('下载文件');
  });
});
