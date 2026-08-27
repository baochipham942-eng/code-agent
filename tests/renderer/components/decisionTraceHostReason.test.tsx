// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostReasonCode, type HostReasonValue } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({ developerMode: true }),
}));

import { RequestDetails } from '../../../src/renderer/components/PermissionDialog/RequestDetails';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';

afterEach(cleanup);

function requestWithReason(reason: HostReasonValue): PermissionRequest {
  return {
    id: 'permission-1',
    tool: 'Bash',
    type: 'command',
    details: { command: 'echo ok' },
    decisionTrace: {
      toolName: 'Bash',
      finalOutcome: 'deny',
      totalDurationMs: 1,
      steps: [{
        layer: 'permission_classifier',
        rule: 'test',
        result: 'deny',
        reason,
        durationMs: 1,
        timestamp: 1,
      }],
    },
  };
}

describe('DecisionTrace host reason rendering', () => {
  it('结构化原因展开后只显示登记表文案，modelText 原串不上屏', () => {
    const modelText = 'MODEL_TEXT_LEAK_SENTINEL: internal classifier jargon';
    render(<RequestDetails request={requestWithReason({
      code: HostReasonCode.PermissionClassifierDenied,
      metadata: { toolName: 'Bash' },
      modelText,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: /审批决策链/ }));
    expect(screen.getByText(/未通过安全检查/)).toBeTruthy();
    expect(screen.queryByText(modelText)).toBeNull();
    expect(document.body.textContent).not.toContain('internal classifier jargon');
  });

  it('旧 trace reason 没有 code 时继续显示原字符串', () => {
    render(<RequestDetails request={requestWithReason('legacy decision reason')} />);
    fireEvent.click(screen.getByRole('button', { name: /审批决策链/ }));
    expect(screen.getByText('legacy decision reason')).toBeTruthy();
  });
});
