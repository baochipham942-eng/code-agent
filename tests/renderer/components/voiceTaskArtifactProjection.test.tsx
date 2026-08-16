// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract/message';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

const dispatchMessage: Message = {
  id: 'voice-dispatch',
  role: 'user',
  content: '创建 12.md',
  timestamp: 1_000,
  metadata: { voiceDispatch: { title: '创建文件', workItemId: 'voice-work-1' } },
};

function resultMessage(withArtifacts = true): Message {
  return {
    id: 'voice-result',
    role: 'system',
    content: '[任务结果] 创建文件｜completed｜已完成',
    timestamp: 2_000,
    metadata: {
      source: 'voice',
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: 'voice-work-1',
        shortName: '创建文件',
        status: 'completed',
        summary: '已完成',
        ...(withArtifacts ? {
          artifacts: [{
            artifactId: 'artifact-12-md',
            kind: 'document',
            role: 'deliverable',
            sourceTool: 'Write',
            label: '12.md',
            path: '/repo/12.md',
            sha256: 'a'.repeat(64),
          }],
        } : {}),
      },
      voiceWorkSettled: { workItemId: 'voice-work-1', title: '创建文件', outcome: 'done' },
    },
  };
}

describe('语音派单产物投影', () => {
  afterEach(() => cleanup());

  it('把结果消息的文件产物交给现有 FileArtifactCard 渲染为可点文件卡', () => {
    const projection = projectTurns([dispatchMessage, resultMessage()], 'session-1', false);
    const artifactNode = projection.turns
      .flatMap((turn) => turn.nodes)
      .find((node) => node.id === 'voice-result-artifact-ownership');

    expect(artifactNode?.turnTimeline?.artifactOwnership).toEqual([
      expect.objectContaining({ kind: 'file', label: '12.md', path: '/repo/12.md' }),
    ]);
    render(<TraceNodeRenderer node={artifactNode!} sessionId="session-1" />);
    const filename = screen.getByText('12.md');
    expect(filename.closest('[role="button"]')).toBeTruthy();
  });

  it('把唯一产物卡移到后续完成播报下，不在原任务卡重复渲染', () => {
    const messages: Message[] = [
      dispatchMessage,
      {
        id: 'voice-user-followup',
        role: 'user',
        content: '好的',
        timestamp: 1_500,
        metadata: { source: 'voice' },
      },
      resultMessage(),
      {
        id: 'voice-completion',
        role: 'assistant',
        content: '文件已经创建好了。',
        timestamp: 3_000,
        metadata: { source: 'voice' },
      },
    ];
    const projection = projectTurns(messages, 'session-1', false);
    const dispatchTurn = projection.turns.find((turn) => (
      turn.nodes.some((node) => node.metadata?.voiceDispatch)
    ));
    const completionTurn = projection.turns.find((turn) => (
      turn.nodes.some((node) => node.id === 'voice-completion-text')
    ));

    expect(dispatchTurn?.nodes.some((node) => node.id === 'voice-result-artifact-ownership')).toBe(false);
    expect(completionTurn?.nodes.filter((node) => node.id === 'voice-result-artifact-ownership')).toHaveLength(1);

    render(<TurnCard turn={completionTurn!} sessionId="session-1" />);
    const completion = screen.getByText('文件已经创建好了。');
    const card = screen.getByRole('button', { name: '打开文件预览: 12.md' });
    expect(completion.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('12.md')).toHaveLength(1);
  });

  it('终态字幕被 host 去重时，用任务结果真摘要补唯一完成锚点', () => {
    const hiddenConclusion: Message = {
      id: 'hidden-conclusion',
      role: 'assistant',
      content: '文件已经创建好了。',
      timestamp: 1_900,
      isMeta: true,
    };
    const projection = projectTurns([dispatchMessage, hiddenConclusion, resultMessage()], 'session-1', false);
    const dispatchTurn = projection.turns.find((turn) => (
      turn.nodes.some((node) => node.metadata?.voiceDispatch)
    ));

    render(<TurnCard turn={dispatchTurn!} sessionId="session-1" />);
    const completion = screen.getByText('已完成');
    const card = screen.getByRole('button', { name: '打开文件预览: 12.md' });
    expect(completion.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('已完成')).toHaveLength(1);
    expect(screen.getAllByText('12.md')).toHaveLength(1);
  });

  it('纯问答结果不投影空产物卡', () => {
    const projection = projectTurns([dispatchMessage, resultMessage(false)], 'session-1', false);
    expect(projection.turns.flatMap((turn) => turn.nodes)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'voice-result-artifact-ownership' })]),
    );
  });
});
