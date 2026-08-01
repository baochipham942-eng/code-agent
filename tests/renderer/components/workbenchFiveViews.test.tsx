// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchViewContent } from '../../../src/renderer/components/WorkbenchViewContent';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/components/WorkbenchOverview', () => ({
  WorkbenchOverview: () => <div data-testid="overview-marker">overview</div>,
}));
vi.mock('../../../src/renderer/components/features/explorer/FileExplorerPanel', () => ({
  FileExplorerPanel: () => <div data-testid="files-marker">files</div>,
}));
vi.mock('../../../src/renderer/components/workbench/BrowserAgentWindow', () => ({
  BrowserAgentWindow: () => <div data-testid="browser-marker">browser</div>,
}));
vi.mock('../../../src/renderer/components/design/DesignCanvasTab', () => ({
  DesignCanvasTab: () => <div data-testid="canvas-marker">canvas</div>,
}));
vi.mock('../../../src/renderer/components/PreviewPanel', () => ({
  PreviewPanel: () => <div data-testid="preview-marker">preview</div>,
}));
vi.mock('../../../src/renderer/components/LivePreview/LivePreviewFrame', () => ({
  default: ({ devServerUrl }: { devServerUrl: string }) => (
    <div data-testid="live-dev-marker">{devServerUrl}</div>
  ),
}));

afterEach(() => {
  cleanup();
  useAppStore.setState({ previewTabs: [], activePreviewTabId: null });
});

describe('five workbench views', () => {
  it.each([
    ['overview', 'overview-marker'],
    ['files', 'files-marker'],
    ['browser', 'browser-marker'],
    ['design-canvas', 'canvas-marker'],
    ['preview:/tmp/report.pdf', 'preview-marker'],
  ] as const)('renders the marker for %s and conditionally excludes the other views', async (activeView, marker) => {
    render(<WorkbenchViewContent activeView={activeView} onCloseFiles={vi.fn()} />);

    expect(await screen.findByTestId(marker)).toBeTruthy();
    for (const otherMarker of [
      'overview-marker',
      'files-marker',
      'browser-marker',
      'canvas-marker',
      'preview-marker',
    ]) {
      if (otherMarker === marker) continue;
      expect(screen.queryByTestId(otherMarker)).toBeNull();
    }
  });
});

// S2 归位（2026-07-31）：liveDev 预览不再借用 'browser' 视图，preview:* 视图内部要
// 按 activeTab.kind 分流到 LivePreviewFrame（liveDev）或 PreviewPanel（file）。
describe('preview view routes by preview tab kind', () => {
  it('renders LivePreviewFrame when the active preview tab is a liveDev tab', async () => {
    useAppStore.setState({
      previewTabs: [{
        id: 'ptab-live',
        path: 'http://localhost:5175',
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: 1,
        isLoaded: true,
        kind: 'liveDev',
        devServerUrl: 'http://localhost:5175',
      }],
      activePreviewTabId: 'ptab-live',
    });

    render(<WorkbenchViewContent activeView="preview:http://localhost:5175" onCloseFiles={vi.fn()} />);

    expect((await screen.findByTestId('live-dev-marker')).textContent).toBe('http://localhost:5175');
    expect(screen.queryByTestId('preview-marker')).toBeNull();
  });

  it('falls back to PreviewPanel when the active preview tab is a file tab', () => {
    useAppStore.setState({
      previewTabs: [{
        id: 'ptab-file',
        path: '/tmp/report.pdf',
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: 1,
        isLoaded: true,
      }],
      activePreviewTabId: 'ptab-file',
    });

    render(<WorkbenchViewContent activeView="preview:/tmp/report.pdf" onCloseFiles={vi.fn()} />);

    expect(screen.getByTestId('preview-marker')).toBeTruthy();
    expect(screen.queryByTestId('live-dev-marker')).toBeNull();
  });
});
