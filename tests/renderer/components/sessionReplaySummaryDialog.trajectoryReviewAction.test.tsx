// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionReplaySummaryDialog } from '../../../src/renderer/components/features/sidebar/SessionReplaySummaryDialog';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';
import type { AgentTrajectorySessionQualitySummary } from '../../../src/shared/contract/agentTrajectory';

function replay(): StructuredReplay {
  const sessionId = 'session-review-action';
  return {
    sessionId,
    traceIdentity: buildSessionTraceIdentity(sessionId),
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns: [],
    summary: {
      totalTurns: 1,
      toolDistribution: {
        Read: 1,
        Edit: 0,
        Write: 0,
        Bash: 0,
        Search: 0,
        Web: 0,
        Agent: 0,
        Skill: 0,
        Other: 0,
      },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 1200,
    },
  };
}

function trajectorySummary(): AgentTrajectorySessionQualitySummary {
  return {
    sessionId: 'session-review-action',
    quality: {
      tier: 'G2',
      passed: true,
      exportReady: true,
      failures: [],
      warnings: [],
      classification: {
        taskKind: 'coding',
        datasetRole: 'core_eval',
        reason: 'g2_agent_task',
        labels: [],
      },
      metrics: {
        turnCount: 1,
        modelCallCount: 1,
        toolCallCount: 1,
        toolResultCount: 1,
        eventCount: 1,
        toolDefinitionCount: 1,
        finalAnswerPresent: true,
        pendingToolResultCount: 0,
      },
    },
    collection: {
      schemaVersion: 1,
      intent: 'new_core_eval_candidate',
      taskKind: 'coding',
      datasetRole: 'core_eval',
      datasetVersion: 'agent-trajectory-v1',
      source: 'quality_gate',
      reason: 'g2_agent_task',
      failureTags: [],
      labels: [],
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

describe('SessionReplaySummaryDialog trajectory review action', () => {
  it('allows confirming the active dataset role as a manual review decision', async () => {
    const onUpdateTrajectoryDatasetRole = vi.fn().mockResolvedValue(undefined);

    render(
      <SessionReplaySummaryDialog
        sessionTitle="Trajectory review"
        replay={replay()}
        trajectorySummary={trajectorySummary()}
        onUpdateTrajectoryDatasetRole={onUpdateTrajectoryDatasetRole}
        onClose={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: '确认复核 核心评测' }) as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button);

    await waitFor(() => {
      expect(onUpdateTrajectoryDatasetRole).toHaveBeenCalledWith('core_eval');
    });
  });
});
