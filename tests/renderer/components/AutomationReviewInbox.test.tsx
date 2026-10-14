// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';

const listPendingReview = vi.fn<() => Promise<SessionAutomationRecord[]>>();
const listParkedApprovals = vi.fn<() => Promise<ParkedApprovalInboxItem[]>>();
const countPendingReview = vi.fn<() => Promise<number | undefined>>();
const markReviewed = vi.fn().mockResolvedValue(null);
const switchSession = vi.fn().mockResolvedValue(undefined);
const ipcInvoke = vi.fn().mockResolvedValue(undefined);
const invokeDomain = vi.fn().mockResolvedValue(undefined);
const toastInfo = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const webMode = vi.hoisted(() => ({ value: false }));
const copyPathToClipboard = vi.hoisted(() => vi.fn(async (_text: string) => true));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/utils/platform', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/utils/platform')>(
    '../../../src/renderer/utils/platform',
  );
  return {
    ...actual,
    isWebMode: () => webMode.value,
    copyPathToClipboard: (text: string) => copyPathToClipboard(text),
  };
});

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: () => listPendingReview(),
    listParkedApprovals: () => listParkedApprovals(),
    countPendingReview: () => countPendingReview(),
    markReviewed: (id: string) => markReviewed(id),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => ipcInvoke(...args),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    isAvailable: () => true,
  },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { switchSession: typeof switchSession }) => unknown) =>
    selector({ switchSession }),
}));

import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

function makeRecord(over: Partial<SessionAutomationRecord>): SessionAutomationRecord {
  return {
    id: 'auto-1',
    sourceSessionId: 'src-1',
    type: 'cron',
    status: 'active',
    title: '英语单词',
    config: { pendingReview: { resultSessionId: 'result-1', at: 1700000000000 } },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // 默认两路都空；具体用例按需 override。
  webMode.value = false;
  copyPathToClipboard.mockClear();
  copyPathToClipboard.mockResolvedValue(true);
  listPendingReview.mockResolvedValue([]);
  listParkedApprovals.mockResolvedValue([]);
  countPendingReview.mockResolvedValue(undefined);
  ipcInvoke.mockResolvedValue(undefined);
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(undefined);
  toastSuccess.mockClear();
  toastError.mockClear();
});

function makeParked(over: Partial<ParkedApprovalInboxItem>): ParkedApprovalInboxItem {
  return {
    id: 'perm_req_1',
    sessionId: 'session-1',
    tool: 'mail_send',
    requestedAt: Date.now() - 120_000,
    status: 'pending',
    riskClass: 'external',
    ...over,
  };
}

describe('AutomationReviewInbox', () => {
  it('无待审时渲染安静空态「都过目完了」', async () => {
    listPendingReview.mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(listPendingReview).toHaveBeenCalled();
    });
    // 收件箱提为独立卡片区后常显：空态卡片在、审批分组不在
    expect(screen.getByTestId('automation-review-inbox')).toBeTruthy();
    expect(screen.getByTestId('automation-review-all-clear')).toBeTruthy();
    expect(screen.queryByTestId('parked-approval-group')).toBeNull();
  });

  it('待过目条数经 onPendingCountChange 回传给页首状态条', async () => {
    listPendingReview.mockResolvedValue([makeRecord({}), makeRecord({ id: 'auto-2' })]);
    const onPendingCountChange = vi.fn();
    render(<AutomationReviewInbox onPendingCountChange={onPendingCountChange} />);
    await waitFor(() => {
      expect(onPendingCountChange).toHaveBeenCalledWith(2);
    });
  });

  it('渲染待审条目，已过目调 markReviewed 并刷新', async () => {
    listPendingReview.mockResolvedValueOnce([makeRecord({})]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-item')).toBeTruthy();
    });
    expect(screen.getByText('英语单词')).toBeTruthy();

    fireEvent.click(screen.getByTestId('automation-review-done'));
    await waitFor(() => {
      expect(markReviewed).toHaveBeenCalledWith('auto-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('automation-review-item')).toBeNull();
    });
  });

  it('目标会话已删除时，在收件箱显示本地化漏跑原因', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      sourceSessionId: 'deleted-session',
      config: {
        pendingReview: { at: 1700000000000 },
        missedNotice: { scheduledAt: 1700000000000, reason: 'app-offline' },
      },
    })]);

    render(<AutomationReviewInbox />);

    await waitFor(() => {
      expect(screen.getByTestId('automation-review-missed').textContent).toContain('应用离线');
    });
  });

  it('云端结果显示位置徽标和离线完成副行', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        runsOn: 'cloud',
        pendingReview: { resultSessionId: 'result-1', at: 1700000000000 },
      },
    })]);
    render(<AutomationReviewInbox />);

    await waitFor(() => expect(screen.getByText('云端')).toBeTruthy());
    expect(screen.getByText(/你不在的时候跑完的 · 完成于/)).toBeTruthy();
  });

  it('在待审行显示 digest，并只为匹配运行会话的 pending 停车审批显示一个徽标', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        pendingReview: {
          resultSessionId: 'result-1',
          at: 1700000000000,
          digest: { artifactCount: 2, summaryLine: '第一行摘要' },
        },
      },
    })]);
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'matching-pending', sessionId: 'result-1', status: 'pending' }),
      makeParked({ id: 'matching-orphaned', sessionId: 'result-1', status: 'orphaned' }),
      makeParked({ id: 'other-pending', sessionId: 'other-session', status: 'pending' }),
    ]);

    render(<AutomationReviewInbox />);

    await waitFor(() => {
      expect(screen.getByTestId('automation-review-digest')).toBeTruthy();
    });
    expect(screen.getByTestId('automation-review-digest').textContent).toContain('2 个产物');
    expect(screen.getByTestId('automation-review-digest').textContent).toContain('第一行摘要');
    expect(screen.queryByTestId('automation-review-digest-toggle')).toBeNull();
    expect(screen.getAllByTestId('automation-review-digest-approval')).toHaveLength(1);
    expect(screen.getByTestId('automation-review-digest-approval').textContent).toBe('有待处理审批');
  });

  it('收件箱摘要丢掉 urgency 机器行，留下人话', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        pendingReview: {
          resultSessionId: 'result-1',
          at: 1700000000000,
          digest: {
            artifactCount: 1,
            summaryLine: 'urgency: fyi\n结果已写入',
            artifacts: [{ path: '/work/run/report.md', openable: true }],
          },
        },
      },
    })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-digest')).toBeTruthy();
    });
    const text = screen.getByTestId('automation-review-digest').textContent ?? '';
    expect(text).toContain('结果已写入');
    expect(text).not.toContain('urgency');
  });

  it('有路径的产物行可展开：桌面打开绝对路径，拒绝则该行显示文件已移走且不弹错误', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        pendingReview: {
          resultSessionId: 'result-1',
          at: 1700000000000,
          digest: {
            artifactCount: 2,
            summaryLine: '第一行摘要',
            artifacts: [
              { path: '/work/run/report.md', openable: true },
              { path: 'notes.md', openable: false },
            ],
          },
        },
      },
    })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-digest-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('cron-artifact-row')).toBeNull();
    fireEvent.click(screen.getByTestId('automation-review-digest-toggle'));
    expect(screen.getByTestId('cron-artifact-open').textContent).toContain('report.md');
    expect(screen.getByTestId('cron-artifact-open').getAttribute('title')).toBe('/work/run/report.md');
    expect(screen.getByTestId('cron-artifact-text').textContent).toContain('notes.md');
    expect(screen.queryAllByTestId('cron-artifact-open')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('cron-artifact-open'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:workspace', 'openPath', { filePath: '/work/run/report.md' });
    });
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cron-artifact-reveal'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:workspace', 'showItemInFolder', { filePath: '/work/run/report.md' });
    });

    invokeDomain.mockRejectedValueOnce(new Error('Path does not exist'));
    fireEvent.click(screen.getByTestId('cron-artifact-open'));
    await waitFor(() => {
      expect(screen.getByTestId('cron-artifact-moved').textContent).toBe('文件已移走');
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('web 模式点击产物复制路径并提示，不调用打开 IPC', async () => {
    webMode.value = true;
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        pendingReview: {
          resultSessionId: 'result-1',
          at: 1700000000000,
          digest: {
            artifactCount: 1,
            artifacts: [{ path: '/work/run/report.md', openable: true }],
          },
        },
      },
    })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-digest-toggle')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('automation-review-digest-toggle'));
    fireEvent.click(screen.getByTestId('cron-artifact-open'));
    await waitFor(() => {
      expect(copyPathToClipboard).toHaveBeenCalledWith('/work/run/report.md');
      expect(toastSuccess).toHaveBeenCalledWith('已复制路径');
    });
    expect(invokeDomain).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('运行次数上限停用记录在收件箱显示停用原因', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      status: 'paused',
      config: {
        pendingReview: {
          at: 1700000000000,
          maxRunsReached: {
            maxRuns: 2,
            summary: '已达运行次数上限（2 次），任务已自动停用。可重新启用。',
          },
        },
      },
    })]);

    render(<AutomationReviewInbox />);

    await waitFor(() => {
      expect(screen.getByTestId('automation-review-max-runs').textContent)
        .toMatch(/已达运行次数上限（\d+ 次）/);
    });
  });

  it('查看结果：标记已读并跳结果会话', async () => {
    listPendingReview.mockResolvedValue([makeRecord({})]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByText('查看结果')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('查看结果'));
    await waitFor(() => {
      expect(markReviewed).toHaveBeenCalledWith('auto-1');
      expect(switchSession).toHaveBeenCalledWith('result-1');
    });
  });

  // B2 停车审批分组
  it('渲染「等待批准的操作」分组，批准回传 permissionResponse（同一 requestId）', async () => {
    listParkedApprovals.mockResolvedValueOnce([makeParked({ id: 'perm_req_1', sessionId: 'session-1' })]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-group')).toBeTruthy();

    fireEvent.click(screen.getByTestId('parked-approve'));
    await waitFor(() => {
      // 复用 agent:permission-response，requestId=停车行 id，sessionId 透传
      expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'perm_req_1', 'allow', 'session-1');
    });
  });

  it('宿主已死（outcome=no_orchestrator）：提示已失效并刷新列表，不静默（D0）', async () => {
    listParkedApprovals.mockResolvedValueOnce([makeParked({ id: 'perm_dead', sessionId: 'session-1' })]).mockResolvedValue([]);
    ipcInvoke.mockResolvedValueOnce({ outcome: 'no_orchestrator' });
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approve')).toBeTruthy();
    });
    const listCallsBefore = listParkedApprovals.mock.calls.length;

    fireEvent.click(screen.getByTestId('parked-approve'));

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalled();
      // 刷新后 orphaned 灰态由下一次 load 呈现
      expect(listParkedApprovals.mock.calls.length).toBeGreaterThan(listCallsBefore);
    });
  });

  it('响应失败（invoke 拒绝）：浮错误 toast 并恢复可点，不再吞掉', async () => {
    listParkedApprovals.mockResolvedValue([makeParked({ id: 'perm_fail', sessionId: 'session-1' })]);
    ipcInvoke.mockRejectedValueOnce(new Error('PENDING_PERMISSION_NOT_FOUND'));
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approve')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('parked-approve'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
  });

  it('拒绝回传 deny', async () => {
    listParkedApprovals.mockResolvedValueOnce([makeParked({ id: 'perm_req_2' })]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-reject')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('parked-reject'));
    await waitFor(() => {
      expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'perm_req_2', 'deny', 'session-1');
    });
  });

  it('orphaned 灰态不给操作按钮', async () => {
    listParkedApprovals.mockResolvedValue([makeParked({ id: 'perm_orph', status: 'orphaned' })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
    });
    expect(screen.queryByTestId('parked-approve')).toBeNull();
    expect(screen.queryByTestId('parked-reject')).toBeNull();
  });

  // 三档分组（N-CRON-INBOX-URGENCY-TIER）
  it('must_today 置顶带角标，fyi 与无档位记录归入 fyi 档', async () => {
    listPendingReview.mockResolvedValue([
      makeRecord({ id: 'auto-fyi', title: '天气速览', config: { pendingReview: { resultSessionId: 'r-fyi', at: 1700000000000, urgency: 'fyi' } } }),
      makeRecord({ id: 'auto-must', title: '发票今天到期', config: { pendingReview: { resultSessionId: 'r-must', at: 1700000000000, urgency: 'must_today' } } }),
      makeRecord({ id: 'auto-none', title: '老记录无档位', config: { pendingReview: { resultSessionId: 'r-none', at: 1700000000000 } } }),
    ]);
    render(<AutomationReviewInbox />);

    await waitFor(() => {
      expect(screen.getByTestId('automation-urgency-section-must_today')).toBeTruthy();
    });
    // 空档（can_wait）不渲染
    expect(screen.queryByTestId('automation-urgency-section-can_wait')).toBeNull();
    expect(screen.getByTestId('automation-urgency-section-fyi')).toBeTruthy();

    // must_today 置顶第一，行带角标；fyi 与无档位两条都在 fyi 档
    const sections = screen.getAllByTestId(/^automation-urgency-section-/);
    expect(sections.map((node) => node.getAttribute('data-testid'))).toEqual([
      'automation-urgency-section-must_today',
      'automation-urgency-section-fyi',
    ]);
    const mustSection = screen.getByTestId('automation-urgency-section-must_today');
    expect(mustSection.contains(screen.getByText('发票今天到期'))).toBe(true);
    expect(mustSection.contains(screen.getByText('天气速览'))).toBe(false);
    expect(screen.getAllByTestId('automation-urgency-badge')).toHaveLength(1);
    expect(screen.getByTestId('automation-urgency-badge').textContent).toBe('今日必办');
    const fyiSection = screen.getByTestId('automation-urgency-section-fyi');
    expect(fyiSection.contains(screen.getByText('天气速览'))).toBe(true);
    expect(fyiSection.contains(screen.getByText('老记录无档位'))).toBe(true);
    // 每行保留既有按钮
    expect(screen.getAllByTestId('automation-review-item')).toHaveLength(3);
    expect(screen.getAllByTestId('automation-review-done')).toHaveLength(3);
  });

  it('can_wait 有记录时渲染在 must_today 之后', async () => {
    listPendingReview.mockResolvedValue([
      makeRecord({ id: 'auto-wait', title: '周报汇总', config: { pendingReview: { resultSessionId: 'r-wait', at: 1700000000000, urgency: 'can_wait' } } }),
      makeRecord({ id: 'auto-must', title: '发票今天到期', config: { pendingReview: { resultSessionId: 'r-must', at: 1700000000000, urgency: 'must_today' } } }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-urgency-section-can_wait')).toBeTruthy();
    });
    expect(screen.getAllByTestId(/^automation-urgency-section-/).map((node) => node.getAttribute('data-testid'))).toEqual([
      'automation-urgency-section-must_today',
      'automation-urgency-section-can_wait',
    ]);
  });

  it('头部行乱值的记录归 fyi 并在行内保留原文', async () => {
    listPendingReview.mockResolvedValue([
      makeRecord({
        id: 'auto-garbled',
        title: '模型写坏头部',
        config: { pendingReview: { resultSessionId: 'r-garbled', at: 1700000000000, urgency: 'fyi', urgencyRaw: 'urgency: maybe' } },
      }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-urgency-raw')).toBeTruthy();
    });
    expect(screen.queryByTestId('automation-urgency-section-must_today')).toBeNull();
    expect(screen.getByTestId('automation-urgency-raw').textContent).toBe('原文：urgency: maybe');
  });
});
