// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { WorkflowLaunchRequest } from '../../../src/shared/contract/scriptRun';

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));

import { WorkflowLaunchCard } from '../../../src/renderer/components/features/workflow/WorkflowLaunchCard';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkflowStore } from '../../../src/renderer/stores/workflowStore';

const request: WorkflowLaunchRequest = {
  id: 'workflow-keyboard',
  status: 'pending',
  requestedAt: 1,
  sessionId: 'session-workflow',
  goal: '验证键盘语义',
  phases: ['inspect', 'verify'],
  estimatedAgentCalls: 2,
  fanoutSites: 1,
  writeHint: false,
  dimensions: {
    cost: '低',
    network: '无',
    contextLeak: '无',
    background: '前台',
  },
};

describe('WorkflowLaunchCard keyboard semantics', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useWorkflowStore.getState().clear();
    useSessionStore.setState({ currentSessionId: 'session-workflow' });
    useWorkflowStore.getState().handleLaunchEvent({ type: 'requested', request });
  });

  afterEach(() => cleanup());

  it('Esc 只收起 workflow 启动卡，不发 reject IPC', () => {
    const view = render(<WorkflowLaunchCard />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(view.getByTestId('workflow-launch-collapsed')).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
