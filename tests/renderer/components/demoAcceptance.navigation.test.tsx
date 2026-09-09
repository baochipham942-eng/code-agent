// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
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
  it('background auto previews do not take focus', () => {
    useAppStore.getState().openPreview('/workspace/report.md', { source: 'auto', activate: false });
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(false);
  });
  it('closes the turn diff when switching to its deliverable', async () => {
    const filePath = '/workspace/report.md';
    const view = render(<FileArtifactCard items={[{ label: 'report.md', path: filePath, kind: 'file', ownerKind: 'tool', ownerLabel: 'Write', role: 'deliverable' }]} fileChangesByPath={new Map([[filePath, { filePath, oldText: '', newText: '# Report', added: 1, removed: 0, isNewFile: true, editCount: 1 }]])} />);
    fireEvent.click(view.getByText('本次修改'));
    expect(view.getByTestId('diff')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '查看成品: report.md' }));
    await waitFor(() => expect(view.queryByTestId('diff')).toBeNull());
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);
  });
});
