// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { FileInfo } from '../../../src/shared/contract';
import { FileExplorerPanel } from '../../../src/renderer/components/features/explorer/FileExplorerPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useExplorerStore } from '../../../src/renderer/stores/explorerStore';

const openPreview = vi.fn();
const domainInvoke = vi.fn();
const originalDomainAPI = window.domainAPI;
const originalOpenPreview = useAppStore.getState().openPreview;
const originalWorkingDirectory = useAppStore.getState().workingDirectory;

const files: FileInfo[] = [
  { name: 'README.md', path: '/repo/README.md', isDirectory: false, size: 128 },
  { name: 'archive.bin', path: '/repo/archive.bin', isDirectory: false, size: 256 },
];

beforeEach(() => {
  openPreview.mockReset();
  domainInvoke.mockReset();
  domainInvoke.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'domainAPI', {
    configurable: true,
    value: { invoke: domainInvoke },
  });
  useAppStore.setState({
    workingDirectory: '/repo',
    openPreview,
  });
  useExplorerStore.setState({
    tabs: [{ id: 'tab-work', rootPath: '/repo', label: 'work' }],
    activeTabId: 'tab-work',
    dirContents: { '/repo': files },
    expandedPaths: new Set(),
    loadingPaths: new Set(),
    selectedPaths: [],
    pendingCreate: null,
  });
});

afterEach(() => {
  cleanup();
  useExplorerStore.getState().reset();
  useAppStore.setState({
    workingDirectory: originalWorkingDirectory,
    openPreview: originalOpenPreview,
  });
  Object.defineProperty(window, 'domainAPI', {
    configurable: true,
    value: originalDomainAPI,
  });
});

describe('FileExplorerPanel', () => {
  it('uses the tab row as the only file chrome and keeps its file operations', () => {
    render(<FileExplorerPanel onClose={vi.fn()} />);

    expect(screen.queryByRole('heading', { level: 3, name: '文件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    expect(screen.getByText('work')).not.toBeNull();
    expect(screen.getByRole('button', { name: '新建文件' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '新建文件夹' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '刷新' })).not.toBeNull();
  });

  it('opens previewable files in-app without invoking the system opener', () => {
    render(<FileExplorerPanel onClose={vi.fn()} />);

    const fileName = screen.getByText('README.md');
    fireEvent.click(fileName);

    expect(openPreview).toHaveBeenCalledWith('/repo/README.md');
    expect(domainInvoke).not.toHaveBeenCalledWith(
      IPC_DOMAINS.WORKSPACE,
      'openPath',
      { filePath: '/repo/README.md' },
    );
    expect(fileName.closest('[title]')).toBeNull();
  });

  it('falls back to the system opener for files the preview cannot render', () => {
    render(<FileExplorerPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('archive.bin'));

    expect(openPreview).not.toHaveBeenCalled();
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.WORKSPACE,
      'openPath',
      { filePath: '/repo/archive.bin' },
    );
  });
});
