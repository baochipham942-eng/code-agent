import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '../../../src/shared/contract';

import { UpdateNotification } from '../../../src/renderer/components/UpdateNotification';

const updateInfo = {
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  releaseNotes: '修复若干问题',
  downloadUrl: 'https://example.com/app.dmg',
  fileSize: 1024 * 1024,
} as unknown as UpdateInfo;

// 验证 UpdateNotification 从手搓 backdrop+容器弹窗迁移到 Modal primitive 后行为不回归
describe('UpdateNotification (Modal primitive 迁移验证)', () => {
  it('idle 态：走 Modal primitive（role=dialog + aria-modal），标题/更新内容/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification updateInfo={updateInfo} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('软件更新');
    expect(html).toContain('发现新版本可用');
    expect(html).toContain('更新内容');
    // footer 动作（idle 态）
    expect(html).toContain('取消');
    expect(html).toContain('立即下载');
  });
});
