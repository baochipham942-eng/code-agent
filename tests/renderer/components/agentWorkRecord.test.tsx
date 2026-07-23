// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const openWorkspacePreview = vi.fn();
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { openWorkspacePreview: typeof openWorkspacePreview }) => unknown) => selector({ openWorkspacePreview }),
}));

import { roleAvatarColor, roleInitial } from '../../../src/renderer/components/features/expert/RoleInitialAvatar';
import { AgentWorkRecordDialog } from '../../../src/renderer/components/features/swarm/AgentWorkRecordDialog';

const agent = {
  id: 'agent-1', name: '牧之', role: 'product-manager', status: 'completed' as const,
  iterations: 3, startTime: 1, endTime: 3_001, tokenUsage: { input: 20, output: 30 }, toolCalls: 2, cost: 0.001,
};

describe('agent work record', () => {
  it('首字与 roleId 派生颜色稳定，中文花名取首字', () => {
    expect(roleInitial('牧之')).toBe('牧');
    expect(roleAvatarColor('product-manager')).toBe(roleAvatarColor('product-manager'));
  });

  it('展示实际任务、完整产出与归档入口，底部返回主会话', () => {
    const onBack = vi.fn();
    const fullOutput = `${'完整产出'.repeat(80)} 收尾证据`;
    render(<AgentWorkRecordDialog agent={agent} onBack={onBack} record={{
      dispatchedTask: '在 /repo 中核对并提交完整结果', finalOutput: fullOutput,
      finalOutputTruncated: true, finalOutputArchiveItemId: 'archive-1', durationMs: 3_000,
      tokensIn: 20, tokensOut: 30, toolCalls: 2, costUsd: 0.001,
    }} />);

    expect(screen.getByTestId('agent-work-task').textContent).toContain('在 /repo 中核对并提交完整结果');
    expect(screen.getByTestId('agent-work-output').textContent).toContain('收尾证据');
    expect(screen.getByTestId('agent-work-output').textContent?.length).toBeGreaterThan(200);
    fireEvent.click(screen.getByText('打开归档'));
    expect(openWorkspacePreview).toHaveBeenCalledWith('archive-1');
    fireEvent.click(screen.getByText('返回主会话'));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
