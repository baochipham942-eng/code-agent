// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivePreviewFrame } from '../../../src/renderer/components/LivePreview/LivePreviewFrame';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const BROWSER_URL = 'https://example.com';
const originalOpenLivePreview = useAppStore.getState().openLivePreview;

describe('LivePreviewFrame browser mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: [],
      activeWorkbenchTab: null,
      language: 'zh',
    });
    useAppStore.getState().openLivePreview(BROWSER_URL);
    const tabId = useAppStore.getState().activePreviewTabId!;
    useAppStore.getState().setSelectedElement(tabId, {
      file: '/repo/src/App.tsx',
      relativeFile: 'src/App.tsx',
      line: 10,
      column: 3,
      tag: 'button',
      text: 'Submit',
      rect: { x: 0, y: 0, width: 100, height: 32 },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ openLivePreview: originalOpenLivePreview });
    vi.useRealTimers();
  });

  it('structurally omits bridge timeout diagnostics and element-selection controls', () => {
    const tabId = useAppStore.getState().activePreviewTabId!;
    render(<LivePreviewFrame tabId={tabId} devServerUrl={BROWSER_URL} />);

    fireEvent.load(screen.getByTitle('Live Preview'));
    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    expect(screen.queryByTestId('live-preview-bridge-status')).toBeNull();
    expect(screen.queryByTestId('live-preview-element-tools')).toBeNull();
    expect(screen.queryByTestId('live-preview-selection-bar')).toBeNull();
    expect(screen.queryByTestId('live-preview-tweak-panel')).toBeNull();
    expect(screen.queryByText('预览没加载出来')).toBeNull();
  });

  it('navigates an edited address through openLivePreview with normalization', () => {
    const tabId = useAppStore.getState().activePreviewTabId!;
    const openLivePreview = vi.fn();
    useAppStore.setState({ openLivePreview });
    render(<LivePreviewFrame tabId={tabId} devServerUrl={BROWSER_URL} />);

    const address = screen.getByRole('textbox', { name: '网页地址' });
    fireEvent.change(address, { target: { value: 'example.org' } });
    fireEvent.keyDown(address, { key: 'Enter', code: 'Enter' });

    expect(openLivePreview).toHaveBeenCalledOnce();
    expect(openLivePreview).toHaveBeenCalledWith('https://example.org');
  });

  it('keeps bridge controls and timeout diagnostics in dev server mode', () => {
    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: [],
      activeWorkbenchTab: null,
    });
    useAppStore.getState().openLivePreview('http://localhost:4173', 'server-1');
    const tabId = useAppStore.getState().activePreviewTabId!;
    render(<LivePreviewFrame tabId={tabId} devServerUrl="http://localhost:4173" />);

    expect(screen.getByTestId('live-preview-bridge-status')).toBeTruthy();
    expect(screen.getByTestId('live-preview-element-tools')).toBeTruthy();
    fireEvent.load(screen.getByTitle('Live Preview'));
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByText('预览没加载出来')).toBeTruthy();
  });
});
