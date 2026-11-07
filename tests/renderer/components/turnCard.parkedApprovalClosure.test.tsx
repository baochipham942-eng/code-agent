// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import type { Message, ToolResult } from '../../../src/shared/contract';
import { PARKED_APPROVAL_CLOSURE_SENTENCES } from '../../../src/shared/parkedApprovalClosure';
import { CronRunSessionStatusBar } from '../../../src/renderer/components/features/chat/CronRunSessionStatusBar';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';

const SESSION_ID = 'cron-session-1';
const JOB_ID = 'cron-job-1';
const EXECUTION_ID = 'cron-execution-1';
const TOOL_CALL_ID = 'bash-call-1';

const runSession = {
  id: SESSION_ID,
  title: '[Schedule] approval restart',
  readOnly: true,
  origin: { kind: 'cron', id: JOB_ID, name: 'approval restart' },
  sourceRunId: EXECUTION_ID,
  createdAt: 1_000,
  updatedAt: 3_000,
  messageCount: 3,
  turnCount: 1,
} as SessionWithMeta;

function storedRunMessages(result: ToolResult): Message[] {
  return [
    { id: 'user-1', role: 'user', content: 'Run the scheduled check', timestamp: 1_000 },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      toolCalls: [{
        id: TOOL_CALL_ID,
        name: 'Bash',
        arguments: { command: 'echo PARKED-APPROVAL-CHECK' },
      }],
    },
    {
      id: 'assistant-1:denied-tool-result:bash-call-1',
      role: 'tool',
      content: JSON.stringify([result]),
      timestamp: 3_000,
      toolResults: [result],
    },
  ];
}

function execution(status: CronJobExecution['status']): CronJobExecution {
  return {
    id: EXECUTION_ID,
    jobId: JOB_ID,
    status,
    scheduledAt: 1_000,
    startedAt: 1_500,
    completedAt: status === 'completed' ? 2_500 : undefined,
    duration: status === 'completed' ? 1_000 : undefined,
    retryAttempt: 0,
    sessionId: SESSION_ID,
  };
}

function renderStoredRun(messages: Message[]): void {
  const hydrated = hydrateToolCallResults(messages);
  const projection = projectTurns(hydrated, SESSION_ID, false);
  expect(projection.turns).toHaveLength(1);
  useSessionStore.setState({
    sessions: [runSession],
    currentSessionId: SESSION_ID,
    messages: hydrated,
  });
  render(
    <TurnCard
      turn={projection.turns[0]}
      sessionId={SESSION_ID}
      afterUserMessage={<CronRunSessionStatusBar sessionId={SESSION_ID} />}
    />,
  );
}

describe('TurnCard cron run record parked approval closure', () => {
  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'standard', language: 'en' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('keeps the interrupted status line and reveals the real post-restart not-run step', async () => {
    vi.spyOn(cronClient, 'getExecutions').mockResolvedValue([execution('interrupted')]);
    const reason = PARKED_APPROVAL_CLOSURE_SENTENCES.runEndedAfterRestart;
    renderStoredRun(storedRunMessages({
      toolCallId: TOOL_CALL_ID,
      success: false,
      error: reason,
      duration: 0,
    }));

    expect((await screen.findByTestId('cron-run-status-text')).textContent)
      .toBe('Interrupted — no result');
    const toolRow = screen.getByTestId('tool-group-head-label').closest('button');
    expect(toolRow?.textContent).toContain(
      'Not run · The run this step belonged to has already ended, so it did not run; you will be asked again the next time it triggers.',
    );
  });

  it('keeps a normal completed run-record tool folded without a turn toggle', async () => {
    vi.spyOn(cronClient, 'getExecutions').mockResolvedValue([execution('completed')]);
    renderStoredRun(storedRunMessages({
      toolCallId: TOOL_CALL_ID,
      success: true,
      output: 'ok',
      duration: 1_000,
    }));

    expect((await screen.findByTestId('cron-run-status-text')).textContent)
      .toBe('Finished · took 1s');
    expect(screen.queryByTestId('tool-group-head-label')).toBeNull();
    expect(screen.queryByRole('button', { name: /Worked for/ })).toBeNull();
  });
});
