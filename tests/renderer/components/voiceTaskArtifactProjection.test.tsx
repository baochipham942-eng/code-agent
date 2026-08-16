// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract/message';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

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
    expect(filename.closest('button')).toBeTruthy();
  });

  it('纯问答结果不投影空产物卡', () => {
    const projection = projectTurns([dispatchMessage, resultMessage(false)], 'session-1', false);
    expect(projection.turns.flatMap((turn) => turn.nodes)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'voice-result-artifact-ownership' })]),
    );
  });
});
