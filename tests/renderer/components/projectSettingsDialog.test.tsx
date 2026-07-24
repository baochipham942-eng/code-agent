// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '../../../src/shared/contract/project';
import { en } from '../../../src/renderer/i18n/en';

const mocks = vi.hoisted(() => ({
  getProjectDetail: vi.fn(),
  getProjectSourceGitStates: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  invokeDomain: vi.fn(),
  isWebMode: vi.fn(),
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  getProjectDetail: mocks.getProjectDetail,
  getProjectSourceGitStates: mocks.getProjectSourceGitStates,
  updateProject: mocks.updateProject,
  deleteProject: mocks.deleteProject,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: mocks.isWebMode,
}));

import { ProjectSettingsDialog } from '../../../src/renderer/components/ProjectSettingsDialog';

function detail(): ProjectDetail {
  return {
    project: {
      id: 'project-1',
      name: 'Neo',
      description: 'Multi-source',
      workspacePath: '/repo/main',
      workspaceKey: 'key',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      sourceRevision: 3,
    },
    sources: [{
      id: 'source-primary',
      projectId: 'project-1',
      path: '/repo/main',
      canonicalPath: '/repo/main',
      role: 'primary',
      access: 'read_write',
      trustState: 'trusted',
      identityDev: '1',
      identityIno: '2',
      createdAt: 1,
      updatedAt: 1,
    }],
    goals: [],
    roles: [],
    sessionIds: [],
  };
}

describe('ProjectSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWebMode.mockReturnValue(false);
    mocks.getProjectDetail.mockResolvedValue(detail());
    mocks.getProjectSourceGitStates.mockResolvedValue([]);
    mocks.updateProject.mockImplementation(async (input) => ({
      ...detail(),
      project: { ...detail().project, sourceRevision: input.revision + 1 },
      sources: input.sources.map((source: Record<string, unknown>, index: number) => ({
        id: source.id ?? `source-${index}`,
        projectId: 'project-1',
        canonicalPath: source.path,
        identityDev: '1',
        identityIno: String(index + 2),
        createdAt: 1,
        updatedAt: 2,
        ...source,
      })),
    }));
    mocks.invokeDomain.mockImplementation(async (_domain, action) => (
      action === 'selectDirectory' ? '/repo/docs' : { state: 'trusted' }
    ));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders English copy and adds an Additional Source as read-only by default', async () => {
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit project' });
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /Add folder/i }));

    await waitFor(() => expect(screen.getAllByTestId('project-source-row')).toHaveLength(2));
    const access = screen.getByLabelText('Source access /repo/docs') as HTMLSelectElement;
    expect(access.value).toBe('read_only');

    fireEvent.change(access, { target: { value: 'read_write' } });
    expect(window.confirm).toHaveBeenCalledWith('Allow Agent Neo to write to this Source?\n/repo/docs');
    expect(access.value).toBe('read_write');
  });

  it('keeps edits open and visible when the atomic save fails', async () => {
    mocks.updateProject.mockRejectedValueOnce(new Error('revision conflict'));
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);
    await screen.findByRole('dialog', { name: 'Edit project' });

    const name = screen.getByLabelText('Project name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Neo changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toContain('revision conflict');
    expect(name.value).toBe('Neo changed');
    expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeTruthy();
  });

  it('accepts an explicit Source path in web mode', async () => {
    mocks.isWebMode.mockReturnValue(true);
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);
    await screen.findByRole('dialog', { name: 'Edit project' });

    fireEvent.change(screen.getByLabelText('Source folder path'), {
      target: { value: '/repo/web-docs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));

    await waitFor(() => expect(screen.getAllByTestId('project-source-row')).toHaveLength(2));
    expect((screen.getByLabelText('Source access /repo/web-docs') as HTMLSelectElement).value).toBe('read_only');
    expect(mocks.invokeDomain).toHaveBeenCalledWith(expect.anything(), 'set', expect.objectContaining({
      workingDirectory: '/repo/web-docs',
    }));
  });
});
