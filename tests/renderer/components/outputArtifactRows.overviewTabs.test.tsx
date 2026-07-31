// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CurrentTurnArtifactOwnershipCard,
  OutputFileRows,
} from '../../../src/renderer/components/TaskPanel/OutputArtifactRows';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/DeliverableCardList', () => ({
  DeliverableCardList: ({ cards }: { cards: Array<{ title: string }> }) => (
    <div data-testid="deliverable-card">{cards[0]?.title}</div>
  ),
}));

describe('overview artifact file routing', () => {
  it('opens an output file through the native file preview callback', () => {
    const onOpenFile = vi.fn();
    const onOpenPreview = vi.fn();

    render(
      <OutputFileRows
        files={[{ path: '/tmp/allow-me.txt', name: 'allow-me.txt', isCore: false }]}
        previewItems={[]}
        onOpenPreview={onOpenPreview}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'allow-me.txt' }));

    expect(onOpenFile).toHaveBeenCalledWith('/tmp/allow-me.txt');
    expect(onOpenPreview).not.toHaveBeenCalled();
  });

  it('resolves a current-turn relative file against the session working directory', () => {
    const onOpenFile = vi.fn();

    render(
      <CurrentTurnArtifactOwnershipCard
        artifactOwnership={[{
          kind: 'file',
          label: 'report.html',
          ownerKind: 'tool',
          ownerLabel: 'Write',
          path: 'dist/report.html',
        }]}
        previewItems={[]}
        workingDirectory="/workspace/project"
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'report.html' }));

    expect(onOpenFile).toHaveBeenCalledWith('/workspace/project/dist/report.html');
  });

  it('keeps inline artifacts on their existing workspace-preview path', () => {
    render(
      <CurrentTurnArtifactOwnershipCard
        artifactOwnership={[{
          kind: 'artifact',
          label: '流程图',
          ownerKind: 'assistant',
          ownerLabel: 'Neo',
        }]}
        previewItems={[]}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByTestId('deliverable-card').textContent).toContain('流程图');
    expect(screen.queryByTestId('overview-artifact-file')).toBeNull();
  });
});
