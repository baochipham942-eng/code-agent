// @vitest-environment jsdom
// ============================================================================
// 二级页窗口拖拽区钉住测试：「二级页在位 + 侧栏展开」时右侧 TitleBar 不渲染，
// 这些页头就是唯一的窗口拖拽/双击缩放入口。Tauri drag.js 裸值只认直接命中，
// 必须 ="deep" 让子树生效（可点元素由 Tauri 自动豁免）。
// ============================================================================
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubTabHeader } from '../../../src/renderer/components/features/capabilityHub/HubTabHeader';

describe('二级页顶栏窗口拖拽区（deep）', () => {
  it('HubTabHeader（能力中心各 tab 页头）是 deep 拖拽区', () => {
    const { container } = render(<HubTabHeader title="专家" />);
    expect(container.querySelector('[data-tauri-drag-region="deep"]')).not.toBeNull();
  });

  it('设置页标题行是 deep 拖拽区（SettingsModal 渲染依赖重，源码钉住）', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/renderer/components/features/settings/SettingsModal.tsx'),
      'utf-8',
    );
    expect(src).toContain('data-tauri-drag-region="deep"');
  });

  it('能力中心顶行导航头是 deep 拖拽区（capabilityHubPage.test.tsx 渲染钉住，这里源码双保险）', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/renderer/components/features/capabilityHub/CapabilityHubPage.tsx'),
      'utf-8',
    );
    expect(src).toContain('data-tauri-drag-region="deep"');
  });
});
