// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceEvidenceCard } from '../../../../src/renderer/components/features/surfaceExecution';
import { surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { surfaceEvidence, surfaceScope } from './fixtures';

const surfaceClient = vi.hoisted(() => ({ getFrame: vi.fn() }));

vi.mock('../../../../src/renderer/services/surfaceExecutionClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/renderer/services/surfaceExecutionClient')>(),
  getSurfaceExecutionFrame: (...args: unknown[]) => surfaceClient.getFrame(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SurfaceEvidenceCard', () => {
  it('renders capture, analysis, and verification as independent state axes', () => {
    render(
      <SurfaceEvidenceCard
        evidence={surfaceEvidence('independent', {
          inspection: {
            captureState: 'captured',
            analysisState: 'analyzing',
            verificationState: 'rejected',
            supportsStepIds: ['step-1'],
            checklist: [{ id: 'item-1', label: 'Hero 图片裁切', status: 'failed', finding: '右侧被截断' }],
          },
        })}
        copy={surfaceExecutionZh}
        language="zh"
      />,
    );

    const axes = screen.getAllByTestId('surface-evidence-axis');
    expect(axes).toHaveLength(3);
    expect(axes.map((axis) => axis.getAttribute('data-state'))).toEqual(['captured', 'analyzing', 'rejected']);
    expect(screen.getByText('已采集')).toBeTruthy();
    expect(screen.getByText('读取中')).toBeTruthy();
    expect(screen.getByText('未通过')).toBeTruthy();
    expect(screen.getByText(/Hero 图片裁切/)).toBeTruthy();
    expect(screen.getByText(/右侧被截断/)).toBeTruthy();
  });

  it('does not claim evidence was read when inspection identity and time are missing', () => {
    render(
      <SurfaceEvidenceCard
        evidence={surfaceEvidence('incomplete', {
          inspection: {
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'not_requested',
            supportsStepIds: [],
            checklist: [],
          },
        })}
        copy={surfaceExecutionZh}
        language="zh"
      />,
    );

    expect(screen.getByText('读取记录不完整')).toBeTruthy();
    expect(screen.queryByText('已读取')).toBeNull();
    expect(screen.getAllByTestId('surface-evidence-axis')[1].getAttribute('data-state')).toBe('incomplete');
  });

  it('shows read only when analyzed evidence carries inspection identity and timestamp', () => {
    const evidence = surfaceEvidence('inspected', {
      assetRef: '/private/tmp/raw-screenshot.png',
    });
    const view = render(
      <SurfaceEvidenceCard evidence={evidence} copy={surfaceExecutionZh} language="zh" />,
    );

    expect(screen.getByText('已读取')).toBeTruthy();
    expect(screen.getByText('已通过')).toBeTruthy();
    expect(screen.getByText('原始证据已保存')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('/private/tmp/raw-screenshot.png');
  });

  it('loads an owner-scoped opaque frame and exposes its frozen capture context', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA';
    surfaceClient.getFrame.mockResolvedValue({
      version: 1,
      assetRef: 'surface-frame://frame-1',
      mimeType: 'image/png',
      dataUrl,
      bytes: 42,
      sha256: 'a'.repeat(64),
      width: 1440,
      height: 900,
    });
    const scope = surfaceScope('preview');
    render(
      <SurfaceEvidenceCard
        evidence={surfaceEvidence('preview', {
          assetRef: 'surface-frame://frame-1',
          captureContext: {
            target: {
              kind: 'browser',
              browserInstanceId: 'browser-preview',
              windowRef: 'window-private',
              tabRef: 'tab-private',
              origin: 'https://travel.example.test',
              documentRevision: 'document-private',
              title: '旅行结果',
            },
            sourceUrl: 'https://travel.example.test/results?token=secret#private',
            viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
          },
        })}
        copy={surfaceExecutionZh}
        language="zh"
        scope={scope}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('surface-evidence-preview')).toBeTruthy());
    expect(surfaceClient.getFrame).toHaveBeenCalledWith({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      assetRef: 'surface-frame://frame-1',
    });
    expect(screen.getByRole('img', { name: '最新页面截图' }).getAttribute('src')).toBe(dataUrl);
    expect(screen.getByText('https://travel.example.test/results')).toBeTruthy();
    expect(screen.getByText('1440×900 @2x')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('token=secret');
    expect(document.body.innerHTML).not.toContain('tab-private');
    fireEvent.click(screen.getByRole('button', { name: '放大查看证据' }));
    expect(screen.getByTestId('surface-evidence-preview').getAttribute('data-expanded')).toBe('true');
  });

  it('fails closed when an opaque frame cannot be read', async () => {
    surfaceClient.getFrame.mockRejectedValue(new Error('owner blocked'));
    render(
      <SurfaceEvidenceCard
        evidence={surfaceEvidence('blocked-preview', { assetRef: 'surface-frame://foreign' })}
        copy={surfaceExecutionZh}
        language="zh"
        scope={surfaceScope('blocked-preview')}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('surface-evidence-preview-unavailable')).toBeTruthy());
    expect(screen.queryByRole('img')).toBeNull();
  });
});
