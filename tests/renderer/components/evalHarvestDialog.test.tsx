// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type { HarvestPreviewResult } from '../../../src/shared/contract/evaluation';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: ipc.invoke,
}));

import { EvalHarvestDialog } from '@internal-evaluation/renderer/evalCenter/EvalHarvestDialog';

const PREVIEW: HarvestPreviewResult = {
  seeds: [{
    sessionId: 'sess-fake-0001',
    sessionTitle: '生成销售报告',
    id: 'draft-fake0001',
    prompt: '读 sales.csv，生成 out/summary.html',
    description: '生成销售报告',
    tags: ['harvest-0904'],
    candidates: [
      { type: 'file_exists', params: { path: 'out/summary.html' }, reason: '会话里写了 out/summary.html' },
      { type: 'tool_called', params: { tool: 'Write' }, reason: '会话里调用了 Write' },
    ],
    notes: [],
  }],
  failed: [],
};

function renderDialog() {
  return render(
    <EvalHarvestDialog
      sessionIds={['sess-fake-0001']}
      onClose={() => {}}
      onOpenSession={() => {}}
      onFinished={() => {}}
    />,
  );
}

/** 走完 B7 模态进到 B8 草稿表单。 */
async function openDraftForm() {
  renderDialog();
  fireEvent.click(screen.getByTestId('eval-harvest-generate'));
  await screen.findByTestId('eval-harvest-save');
}

beforeEach(() => {
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === EVALUATION_CHANNELS.HARVEST_PREVIEW) return PREVIEW;
    return { action: 'create-draft', id: 'draft-fake0001', file: 'drafts/draft-fake0001.yaml' };
  });
});

afterEach(() => {
  cleanup();
  ipc.invoke.mockReset();
});

describe('B7 字段映射清单', () => {
  it('会话 id 行勾选锁定不可取消，助手回复行整行置灰不可勾', () => {
    renderDialog();

    const sessionRow = screen.getByTestId('eval-harvest-field-sourceSessionId');
    const sessionBox = sessionRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(sessionBox.checked).toBe(true);
    expect(sessionBox.disabled).toBe(true);
    expect(sessionRow.textContent).toContain('来源必须留，不可取消');

    const replyRow = screen.getByTestId('eval-harvest-field-assistantReply');
    const replyBox = replyRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(replyBox.checked).toBe(false);
    expect(replyBox.disabled).toBe(true);
    expect(replyRow.className).toContain('opacity-50');

    // 工具调用序列默认不勾（防题面泄答案）；琥珀提示常驻。
    const traceBox = screen.getByTestId('eval-harvest-field-toolTrace')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(traceBox.checked).toBe(false);
    expect(screen.getByTestId('eval-harvest-standing-hint').textContent)
      .toContain('没被你确认的不会进正式集');
  });
});

describe('B8 草稿表单的保存门槛', () => {
  it('零确认时保存按钮置灰且理由常驻，确认一条后才亮起', async () => {
    await openDraftForm();

    const save = screen.getByTestId('eval-harvest-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId('eval-harvest-save-reason').textContent).toBe('至少确认 1 条才能保存');
    expect(screen.getByTestId('eval-harvest-zero-hint')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('file_exists'));

    expect((screen.getByTestId('eval-harvest-save') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('eval-harvest-save-reason').textContent).toBe('已确认 1 条 · 可保存');
    expect(screen.queryByTestId('eval-harvest-zero-hint')).toBeNull();
  });

  it('只把人确认过的那条写进 create-draft，未勾的候选不进去', async () => {
    await openDraftForm();
    fireEvent.click(screen.getByLabelText('file_exists'));
    fireEvent.click(screen.getByTestId('eval-harvest-save'));

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith(EVALUATION_CHANNELS.SAVE_CASE, expect.objectContaining({
        action: 'create-draft',
        id: 'draft-fake0001',
        sourceSessionId: 'sess-fake-0001',
        pending: false,
        expectations: [
          { type: 'file_exists', params: { path: 'out/summary.html' }, reason: '会话里写了 out/summary.html' },
        ],
      }));
    });
  });

  it('「存为待办」不受门槛限制，落草稿区且不带判定标准', async () => {
    await openDraftForm();
    expect((screen.getByTestId('eval-harvest-save-pending') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('eval-harvest-save-pending'));

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith(EVALUATION_CHANNELS.SAVE_CASE, expect.objectContaining({
        pending: true,
        expectations: [],
      }));
    });
  });

  it('删掉唯一确认过的候选后按钮重新置灰（没有绕过出口）', async () => {
    await openDraftForm();
    fireEvent.click(screen.getByLabelText('file_exists'));
    expect((screen.getByTestId('eval-harvest-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getAllByLabelText('删掉这条候选')[0]);

    expect((screen.getByTestId('eval-harvest-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('eval-harvest-save-reason').textContent).toBe('至少确认 1 条才能保存');
  });
});
