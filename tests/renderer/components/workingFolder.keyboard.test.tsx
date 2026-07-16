// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ tauri: true, web: false }));
const revealNativePath = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  workingDirectory: '/repo/project',
  setWorkingDirectory: vi.fn(),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isTauriMode: () => platform.tauri,
  isWebMode: () => platform.web,
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeDirectory: vi.fn(),
  revealNativePath,
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => appState,
}));
vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (value: { workingDirectory: null }) => unknown) =>
    selector({ workingDirectory: null }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 'tool-1', name: 'Read', arguments: { file_path: '/repo/project/file.ts' } },
        ],
      },
    ],
  }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      taskPanel: {
        workingFolder: 'Working Folder',
        inputDirPlaceholder: 'Directory',
        confirm: 'Confirm',
        noWorkspace: 'Choose workspace',
        noRecentFiles: 'No recent files',
      },
    },
  }),
}));

import { WorkingFolder } from '../../../src/renderer/components/TaskPanel/WorkingFolder';

beforeEach(() => {
  platform.tauri = true;
  platform.web = false;
  revealNativePath.mockReset();
  revealNativePath.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('WorkingFolder native-path keyboard interaction', () => {
  it('renders Tauri reveal targets as native buttons and activates them from the keyboard', async () => {
    const { getByTitle } = render(<WorkingFolder />);
    const directory = getByTitle('/repo/project');
    const file = getByTitle('/repo/project/file.ts');

    expect(directory.tagName).toBe('BUTTON');
    expect(file.tagName).toBe('BUTTON');

    directory.focus();
    fireEvent.keyDown(directory, { key: 'Enter' });
    file.focus();
    fireEvent.keyDown(file, { key: ' ' });

    await waitFor(() => {
      expect(revealNativePath).toHaveBeenCalledWith('/repo/project');
      expect(revealNativePath).toHaveBeenCalledWith('/repo/project/file.ts');
    });
  });

  it.each([
    ['Web', true],
    ['legacy desktop', false],
  ])('renders plain noninteractive reveal content in %s mode', (_label, web) => {
    platform.tauri = false;
    platform.web = web;
    const { getByTitle } = render(<WorkingFolder />);
    const directory = getByTitle('/repo/project');
    const file = getByTitle('/repo/project/file.ts');

    expect(directory.tagName).toBe('DIV');
    expect(file.tagName).toBe('DIV');
    expect(directory.hasAttribute('role')).toBe(false);
    expect(file.hasAttribute('role')).toBe(false);

    fireEvent.click(directory);
    fireEvent.click(file);
    expect(revealNativePath).not.toHaveBeenCalled();
  });
});
