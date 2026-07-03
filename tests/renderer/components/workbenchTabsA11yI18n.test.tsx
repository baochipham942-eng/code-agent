// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// WorkbenchTabs —— 顶栏 icon-only 按钮可发现性 + i18n（UI 审计 #9 收尾）：
//  A) 「+」按钮 aria-label/tooltip 走 i18n，en 态不再是硬编码中文「打开面板」；
//  B) 「+」弹出菜单条目（任务/文件/上下文）en 态渲染英文标签；
//  C) files / context tab 的 label 与 title 走 i18n。
// 画布/媒介表单两枚按钮已有 aria-label+title（design.* 键），此处一并断言存在。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('../../../src/renderer/hooks/useDisclosure', () => ({
  useDisclosure: () => ({ isStandard: true }),
}));
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
}));
vi.mock('../../../src/renderer/stores/workbenchPresetStore', () => {
  const useWorkbenchPresetStore = (selector: (s: { presets: unknown[]; recipes: unknown[] }) => unknown) =>
    selector({ presets: [], recipes: [] });
  return { useWorkbenchPresetStore };
});

import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ workbenchTabs: [], activeWorkbenchTab: null, previewTabs: [], language: 'en' });
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  useSessionStore.setState({ currentSessionId: null });
});

describe('WorkbenchTabs 顶栏按钮 a11y + i18n（en 态无硬编码中文）', () => {
  it('「+」按钮 aria-label 走 i18n：en 态为英文，且不是「打开面板」', () => {
    const { container } = render(<WorkbenchTabs />);
    const addBtn = container.querySelector(`[aria-label="${en.workbenchTabs.openPanel}"]`);
    expect(addBtn).toBeTruthy();
    expect(container.querySelector('[aria-label="打开面板"]')).toBeNull();
  });

  it('「+」弹出菜单条目 en 态渲染英文（无「文件」「上下文」硬编码）', () => {
    const { container, getByLabelText } = render(<WorkbenchTabs />);
    fireEvent.click(getByLabelText(en.workbenchTabs.openPanel));
    expect(container.textContent).toContain(en.workbenchTabs.filesLabel);
    expect(container.textContent).toContain(en.workbenchTabs.contextLabel);
    expect(container.textContent).not.toContain('文件');
    expect(container.textContent).not.toContain('上下文');
  });

  it('files / context tab 的 label 与 title 走 i18n', () => {
    useAppStore.setState({ workbenchTabs: ['files', 'context'], activeWorkbenchTab: 'files' });
    const { container } = render(<WorkbenchTabs />);
    expect(container.textContent).toContain(en.workbenchTabs.filesLabel);
    expect(container.textContent).toContain(en.workbenchTabs.contextLabel);
    expect(container.querySelector(`[title="${en.workbenchTabs.filesTitle}"]`)).toBeTruthy();
    expect(container.querySelector(`[title="${en.workbenchTabs.contextTitle}"]`)).toBeTruthy();
  });

  it('zh 态「+」按钮仍为中文 aria-label（键值对齐）', () => {
    useAppStore.setState({ language: 'zh' });
    const { container } = render(<WorkbenchTabs />);
    expect(container.querySelector(`[aria-label="${zh.workbenchTabs.openPanel}"]`)).toBeTruthy();
  });

  it('画布与媒介表单两枚 icon-only 按钮具备 aria-label 与 title', () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    const { getByTestId } = render(<WorkbenchTabs />);
    for (const id of ['open-design-canvas', 'open-design-legacy-form']) {
      const btn = getByTestId(id);
      expect(btn.getAttribute('aria-label')).toBeTruthy();
      expect(btn.getAttribute('title')).toBeTruthy();
    }
  });
});
