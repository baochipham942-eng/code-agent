// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactThumbStrip } from '../../../src/renderer/components/TaskPanel/OutputArtifactRows';

describe('overview artifact thumb strip routing', () => {
  it('opens an output file through the native file preview callback', () => {
    const onOpenFile = vi.fn();
    const onOpenPreview = vi.fn();

    render(
      <ArtifactThumbStrip
        items={[{
          kind: 'file',
          label: 'allow-me.txt',
          ownerKind: 'tool',
          ownerLabel: 'Write',
          path: '/tmp/allow-me.txt',
        }]}
        previewItems={[]}
        unnamedLabel="未命名输出"
        onOpenPreview={onOpenPreview}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByTestId('overview-artifact-thumb'));

    expect(onOpenFile).toHaveBeenCalledWith('/tmp/allow-me.txt');
    expect(onOpenPreview).not.toHaveBeenCalled();
  });

  it('resolves a current-turn relative file against the session working directory', () => {
    const onOpenFile = vi.fn();

    render(
      <ArtifactThumbStrip
        items={[{
          kind: 'file',
          label: 'report.html',
          ownerKind: 'tool',
          ownerLabel: 'Write',
          path: 'dist/report.html',
        }]}
        previewItems={[]}
        workingDirectory="/workspace/project"
        unnamedLabel="未命名输出"
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByTestId('overview-artifact-thumb'));

    expect(onOpenFile).toHaveBeenCalledWith('/workspace/project/dist/report.html');
  });

  it('routes items with a matching workspace preview item through the preview callback', () => {
    const onOpenPreview = vi.fn();

    render(
      <ArtifactThumbStrip
        items={[{
          kind: 'file',
          label: 'chart.png',
          ownerKind: 'tool',
          ownerLabel: 'image_generate',
          path: '/tmp/chart.png',
        }]}
        previewItems={[{
          id: 'file:/tmp/chart.png',
          kind: 'image',
          title: 'chart.png',
          status: 'ready',
          createdAt: 1,
          source: { kind: 'tool', label: 'image_generate' },
          file: { path: '/tmp/chart.png', name: 'chart.png' },
        } as never]}
        unnamedLabel="未命名输出"
        onOpenPreview={onOpenPreview}
      />,
    );

    fireEvent.click(screen.getByTestId('overview-artifact-thumb'));

    expect(onOpenPreview).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file:/tmp/chart.png',
      file: { path: '/tmp/chart.png', name: 'chart.png' },
    }));
  });
});
