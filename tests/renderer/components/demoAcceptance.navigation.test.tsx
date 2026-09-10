// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { wrapFilePathsInBackticks, wrapTicketsAsLinks } from '../../../src/renderer/components/features/chat/MessageBubble/filePathProcessor';
import { FileArtifactCard } from '../../../src/renderer/components/features/chat/MessageBubble/FileArtifactCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';
import { zh } from '../../../src/renderer/i18n';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/components/DiffView', () => ({ DiffView: () => <div data-testid="diff">changes</div> }));

afterEach(cleanup);
beforeEach(() => {
  useAppStore.setState({ workingDirectory: '/workspace', previewTabs: [], workbenchTabs: [], activeWorkbenchTab: null, activePreviewTabId: null, workbenchCollapsed: true });
  useWorkbenchFocusStore.setState({ workbenchFocused: false });
});
describe('deliverable and command navigation', () => {
  it('opens a historic !open report in the focused app preview', async () => {
    const view = render(<MessageContent content={'[/workspace/report.md](!open)'} isUser={false} />);
    await waitFor(() => expect(view.getByTitle('打开文件')).toBeTruthy());
    fireEvent.click(view.getByTitle('打开文件'));
    await waitFor(() => expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/workspace/report.md'));
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);
  });
  it('renders one command action and dispatches its exact quoted text', async () => {
    const command = 'python3 "/workspace/演示/build_ppt.py"';
    const receive = vi.fn();
    window.addEventListener('iact:run', receive);
    try {
      const view = render(<MessageContent content={`[${command}](!run)`} isUser={false} />);
      const button = await view.findByRole('button', { name: '运行生成脚本' });
      expect(view.container.querySelectorAll('button')).toHaveLength(1);
      expect(view.container.textContent).toContain(command);
      expect(receive).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect((receive.mock.calls[0][0] as CustomEvent).detail).toBe(command);
    } finally { window.removeEventListener('iact:run', receive); }
  });
  // ai-review #1739 Important：链接扫描正则里 (?:[^\]\n]|\\.)* 的两个分支对反斜杠歧义，
  // 行内有未闭合的 `[` 时整体匹配失败会让引擎穷举切分，步数随反斜杠个数 2^k 增长。这两条
  // 输入在旧正则下实测 7~38 秒（renderer 主线程同步跑，流式期间每 chunk 重跑一次 = 界面卡死）。
  // 用挂钟时间钉住：只要有人把歧义分支写回来，这条就红。
  it.each([
    ['未闭合 [ 加一串反斜杠转义', '[' + '\\x'.repeat(28)],
    ['行内 LaTeX 公式', 'note \\[ \\sum \\alpha \\beta \\gamma \\delta \\epsilon \\zeta \\eta \\theta \\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\rho \\sigma \\tau \\phi \\chi \\psi \\omega \\Gamma \\Delta \\Theta \\Lambda'],
    ['未闭合 [ 加 Windows 路径', 'see [these: C:\\Users\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\o\\p\\q\\r\\s\\t\\u\\v\\w\\x\\y\\z\\aa\\bb'],
  ])('链接扫描对 %s 不发生指数回溯', (_label, input) => {
    const started = Date.now();
    wrapFilePathsInBackticks(input);
    wrapTicketsAsLinks(input);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('background auto previews do not take focus', () => {
    useAppStore.getState().openPreview('/workspace/report.md', { source: 'auto', activate: false });
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(false);
  });
  it('closes the turn diff when switching to its deliverable', async () => {
    const filePath = '/workspace/report.md';
    const view = render(<FileArtifactCard items={[{ label: 'report.md', path: filePath, kind: 'file', ownerKind: 'tool', ownerLabel: 'Write', role: 'deliverable' }]} fileChangesByPath={new Map([[filePath, { filePath, oldText: '', newText: '# Report', added: 1, removed: 0, isNewFile: true, editCount: 1 }]])} />);
    fireEvent.click(view.getByText('本次修改'));
    expect(view.getByTestId('diff')).toBeTruthy();
    fireEvent.click(view.getByText('成品'));
    await waitFor(() => expect(view.queryByTestId('diff')).toBeNull());
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);
  });
});
