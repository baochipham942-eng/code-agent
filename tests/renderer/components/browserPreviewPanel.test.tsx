// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPreviewPanel } from '../../../src/renderer/components/BrowserPreviewPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/components/LivePreview/LivePreviewFrame', () => ({
  default: ({ devServerUrl }: { devServerUrl: string }) => (
    <div data-testid="live-preview-frame">{devServerUrl}</div>
  ),
}));

describe('BrowserPreviewPanel', () => {
  beforeEach(() => {
    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: [],
      activeWorkbenchTab: null,
      language: 'zh',
    });
  });

  afterEach(() => cleanup());

  it('renders LivePreviewFrame only for the active URL-backed preview', async () => {
    useAppStore.getState().openLivePreview('http://127.0.0.1:4173', 'server-1');
    render(<BrowserPreviewPanel />);

    expect((await screen.findByTestId('live-preview-frame')).textContent).toBe('http://127.0.0.1:4173');
    expect(screen.queryByTestId('workbench-browser-empty')).toBeNull();
  });

  it('uses conditional empty rendering when no URL is active', () => {
    render(<BrowserPreviewPanel />);

    expect(screen.getByTestId('workbench-browser-empty')).toBeTruthy();
    expect(screen.queryByTestId('live-preview-frame')).toBeNull();
  });

  it('normalizes a scheme-less address before opening a live preview', () => {
    const openLivePreview = vi.fn();
    useAppStore.setState({ openLivePreview });
    render(<BrowserPreviewPanel />);

    const address = screen.getByRole('textbox', { name: '网页地址' });
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.keyDown(address, { key: 'Enter', code: 'Enter' });

    expect(openLivePreview).toHaveBeenCalledOnce();
    expect(openLivePreview).toHaveBeenCalledWith('https://example.com');
  });
});
