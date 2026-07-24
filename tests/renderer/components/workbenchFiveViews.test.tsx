// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchViewContent } from '../../../src/renderer/components/WorkbenchViewContent';

vi.mock('../../../src/renderer/components/WorkbenchOverview', () => ({
  WorkbenchOverview: () => <div data-testid="overview-marker">overview</div>,
}));
vi.mock('../../../src/renderer/components/features/explorer/FileExplorerPanel', () => ({
  FileExplorerPanel: () => <div data-testid="files-marker">files</div>,
}));
vi.mock('../../../src/renderer/components/BrowserPreviewPanel', () => ({
  BrowserPreviewPanel: () => <div data-testid="browser-marker">browser</div>,
}));
vi.mock('../../../src/renderer/components/design/DesignCanvasTab', () => ({
  DesignCanvasTab: () => <div data-testid="canvas-marker">canvas</div>,
}));
vi.mock('../../../src/renderer/components/PreviewPanel', () => ({
  PreviewPanel: () => <div data-testid="preview-marker">preview</div>,
}));

afterEach(() => cleanup());

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
