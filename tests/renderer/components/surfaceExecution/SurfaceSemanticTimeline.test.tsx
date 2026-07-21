// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SurfaceSemanticTimeline } from '../../../../src/renderer/components/features/surfaceExecution';
import { surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { surfaceEvent, surfaceScope } from './fixtures';

afterEach(() => {
  cleanup();
});

describe('SurfaceSemanticTimeline', () => {
  it('renders the user-facing reason for a cross-Surface switch without exposing the raw action', () => {
    const reason = '因为最终产物需要页面截图复验，已从 Computer 返回 Browser';
    const event = surfaceEvent(surfaceScope('switch'), {
      phase: 'prepare',
      status: 'succeeded',
      userSummary: reason,
      operation: {
        action: 'surface_switch',
        risk: 'control',
        approvalScope: 'from:computer-workbuddy',
        expectedOutcome: '在浏览器中打开最终产物并复验页面截图',
      },
    });

    const view = render(
      <SurfaceSemanticTimeline events={[event]} copy={surfaceExecutionZh} />,
    );

    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByTestId('surface-timeline-event').getAttribute('data-phase')).toBe('prepare');
    expect(view.container.textContent).not.toContain('surface_switch');
    expect(view.container.textContent).not.toContain('from:computer-workbuddy');
  });
});
