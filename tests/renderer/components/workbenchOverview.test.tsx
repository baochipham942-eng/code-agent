// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchOverview } from '../../../src/renderer/components/WorkbenchOverview';

vi.mock('../../../src/renderer/components/TaskPanel', () => ({
  TaskPanel: () => <div data-testid="task-progress-marker">task progress</div>,
}));
vi.mock('../../../src/renderer/components/WorkspacePreviewPanel', () => ({
  WorkspacePreviewPanel: () => <div data-testid="artifact-marker">artifacts</div>,
}));

afterEach(() => cleanup());

describe('WorkbenchOverview', () => {
  it('combines task progress and deliverables as two rendered sections', () => {
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-progress')).toBeTruthy();
    expect(screen.getByTestId('task-progress-marker')).toBeTruthy();
    expect(screen.getByTestId('workbench-overview-artifacts')).toBeTruthy();
    expect(screen.getByTestId('artifact-marker')).toBeTruthy();
  });
});
