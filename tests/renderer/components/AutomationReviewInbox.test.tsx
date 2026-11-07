// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { cronClient } from '../../../src/renderer/services/cronClient';

const listPendingReview = vi.fn<() => Promise<SessionAutomationRecord[]>>();
const listParkedApprovals = vi.fn<() => Promise<ParkedApprovalInboxItem[]>>();
const countPendingReview = vi.fn<() => Promise<number | undefined>>();
const markReviewed = vi.fn().mockResolvedValue(null);
const switchSession = vi.fn().mockResolvedValue(undefined);
const ipcInvoke = vi.fn().mockResolvedValue(undefined);
const ipcInvokeDomain = vi.fn().mockResolvedValue(undefined);
// 面板「等批准」轮询的可变应答（Rework r1 用例翻转它模拟停车出现）
const awaitingRunsMock = vi.hoisted(() => ({ value: [] as unknown[] }));
const toastInfo = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const webMode = vi.hoisted(() => ({ value: false }));
const copyPathToClipboard = vi.hoisted(() => vi.fn(async (_text: string) => true));
const originalTriggerJob = useCronStore.getState().triggerJob;

// 语言可切换的 useI18n mock：默认 zh（与原真实 hook 的默认一致，存量断言不变），
// 参数预览词条用例临时切 en（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST ④）。
const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

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
    listAwaitingApprovalRuns: () => Promise.resolve(awaitingRunsMock.value),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => ipcInvoke(...args),
    invokeDomain: (...args: unknown[]) => ipcInvokeDomain(...args),
    isAvailable: () => true,
  },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { switchSession: typeof switchSession }) => unknown) =>
    selector({ switchSession }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: i18nState.language === 'en' ? en : zh,
      language: i18nState.language,
    }),
  };
});

// parity 用例（见文末）渲染整个 CronCenterPanel：cron 数据走 cronClient mock，
// 重子组件置空避免把编辑器/列表细节拖进这个文件。真模块同时有具名与 default
// 两个导出（cronLoginWallNotice 走 default），mock 面保持同形，别只给具名。
vi.mock('../../../src/renderer/services/cronClient', () => {
  const mocked = {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    grantLoginPassThrough: vi.fn().mockResolvedValue(null),
  };
  return { cronClient: mocked, default: mocked };
});
vi.mock('../../../src/renderer/components/features/cron/CronFeaturedTemplates', () => ({
  CronFeaturedTemplates: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobList', () => ({
  CronJobList: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobDetail', () => ({
  CronJobDetail: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';
import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { countPendingReviewByTask } from '../../../src/shared/cronRunDigest';

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
  useCronStore.setState({ triggerJob: originalTriggerJob });
  i18nState.language = 'zh';
});

beforeEach(() => {
  // 默认两路都空；具体用例按需 override。
  webMode.value = false;
  awaitingRunsMock.value = [];
  copyPathToClipboard.mockClear();
  copyPathToClipboard.mockResolvedValue(true);
  listPendingReview.mockResolvedValue([]);
  listParkedApprovals.mockResolvedValue([]);
  countPendingReview.mockResolvedValue(undefined);
  ipcInvoke.mockResolvedValue(undefined);
  ipcInvokeDomain.mockReset();
  ipcInvokeDomain.mockResolvedValue(undefined);
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

  it('登录墙收件箱同时提供 Neo 浏览器登录和立即重跑', async () => {
    const triggerJob = vi.fn().mockResolvedValue(null);
    useCronStore.setState({ triggerJob });
    listPendingReview.mockResolvedValue([makeRecord({
      sourceRefId: 'job-login-wall',
      config: {
        loginWall: { siteOrigin: 'https://example.test', at: 1700000000000 },
      },
    })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-open-login-site')).toBeTruthy();
    });

    expect(screen.getByTestId('automation-review-open-login-site').textContent)
      .toContain('在 Neo 浏览器中登录');
    fireEvent.click(screen.getByTestId('automation-review-open-login-site'));
    expect(ipcInvokeDomain).toHaveBeenCalledWith(
      'domain:desktop',
      'openManagedBrowserUrl',
      { url: 'https://example.test', mode: 'visible', profileMode: 'persistent' },
    );

    fireEvent.click(screen.getByTestId('automation-review-login-wall-rerun'));
    await waitFor(() => {
      expect(triggerJob).toHaveBeenCalledWith('job-login-wall');
    });
  });

  it('立即重跑失败时在收件箱提示失败并恢复可操作状态', async () => {
    const triggerJob = vi.fn().mockRejectedValue(new Error('trigger failed'));
    useCronStore.setState({ triggerJob });
    listPendingReview.mockResolvedValue([makeRecord({
      sourceRefId: 'job-login-wall',
      config: {
        loginWall: { siteOrigin: 'https://example.test', at: 1700000000000 },
      },
    })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-login-wall-rerun')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('automation-review-login-wall-rerun'));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('运行失败');
    });
    expect(triggerJob).toHaveBeenCalledWith('job-login-wall');
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

  it('webhook 过期通告显示丢弃条数，不写成应用离线', async () => {
    listPendingReview.mockResolvedValue([makeRecord({
      config: {
        pendingReview: { at: 1700000000000 },
        missedNotice: { scheduledAt: 1700000000000, reason: 'webhook-expired', count: 4 },
      },
    })]);

    render(<AutomationReviewInbox />);

    await waitFor(() => {
      expect(screen.getByTestId('automation-review-missed').textContent).toContain('4');
    });
    const text = screen.getByTestId('automation-review-missed').textContent ?? '';
    expect(text).toContain('24');
    expect(text).not.toContain('应用离线');
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
      expect(ipcInvokeDomain).toHaveBeenCalledWith('domain:workspace', 'openPath', { filePath: '/work/run/report.md' });
    });
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cron-artifact-reveal'));
    await waitFor(() => {
      expect(ipcInvokeDomain).toHaveBeenCalledWith('domain:workspace', 'showItemInFolder', { filePath: '/work/run/report.md' });
    });

    ipcInvokeDomain.mockRejectedValueOnce(new Error('Path does not exist'));
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
    expect(ipcInvokeDomain).not.toHaveBeenCalled();
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

  it('REALRUN ②：voided 项灰态只读，显示工具名 + 作废句，无按钮；标题计数只算 pending', async () => {
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_pending' }),
      makeParked({
        id: 'perm_void', status: 'voided', tool: 'Bash',
        voidReason: '这一步等你确认超过 24 小时，已自动作废，没有执行。',
      }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-voided')).toBeTruthy();
    });
    const voided = screen.getByTestId('parked-approval-voided');
    expect(voided.textContent).toContain('Bash');
    expect(voided.textContent).toContain('这一步等你确认超过 24 小时，已自动作废，没有执行。');
    expect(voided.querySelector('button')).toBeNull();
    expect(screen.getAllByTestId('parked-approve')).toHaveLength(1);
    expect(screen.getByTestId('parked-approval-group').textContent).toContain('1 个操作等你确认');
  });

  it('REALRUN ②：只有 voided 项时不出「0 个操作等你确认」标题', async () => {
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_void', status: 'voided', tool: 'Bash', voidReason: 'x' }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-voided')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-group').textContent).not.toContain('0 个操作');
  });

  it('REALRUN ②：zh / en 两份文案都有 parkedVoidedLabel', async () => {
    const { zh } = await import('../../../src/renderer/i18n/zh');
    const { en } = await import('../../../src/renderer/i18n/en');
    expect(zh.cronCenter.parkedVoidedLabel).toBeTruthy();
    expect(en.cronCenter.parkedVoidedLabel).toBeTruthy();
  });

  // voidReason 持久化的是中文收口原句（含重启前落库的老行）；英文 UI 按原句查表翻出英文句，
  // 中文 UI 输出与原句字节一致；非收口文本原样保留。三句 × 两语言。
  it.each([
    ['expiredAfterRestart24h', '这一步等你确认超过 24 小时，已自动作废，没有执行。',
      'This step waited for your confirmation for over 24 hours, so it was voided automatically and did not run.'],
    ['workingDirectoryUnavailable', '这次对话没有工作目录，重启后无法安全执行，没有执行。',
      "This conversation has no working directory, so it can't be run safely after a restart. It did not run."],
    ['runEndedAfterRestart', '所属运行已结束，没有执行；下次触发会重新询问你。',
      'The run this step belonged to has already ended, so it did not run; you will be asked again the next time it triggers.'],
    ['argsUnavailable', '应用重启后找不到这一步的完整信息，为安全起见没有执行。',
      'After the app restarted, the full details of this step could not be found, so it was not run for safety.'],
  ] as const)('voided 行 %s：zh 显原句 / en 显译文', async (_key, zhSentence, enSentence) => {
    // zh：老行原句原样（字节一致）
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_void', status: 'voided', tool: 'Bash', voidReason: zhSentence }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-voided')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-voided').textContent).toContain(`已作废：${zhSentence}`);
    cleanup();

    // en：同一行（老行字面量）翻成英文句
    i18nState.language = 'en';
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_void', status: 'voided', tool: 'Bash', voidReason: zhSentence }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-voided')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-voided').textContent).toContain(`Voided：${enSentence}`);
    expect(screen.getByTestId('parked-approval-voided').textContent).not.toContain(zhSentence);
  });

  it('voidReason 是普通文本（非收口句）时原样显示，不套翻译', async () => {
    i18nState.language = 'en';
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_void_raw', status: 'voided', tool: 'Bash', voidReason: '已手动取消' }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-voided')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-voided').textContent).toContain('Voided：已手动取消');
  });

  // N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST ④：停车审批行带参数预览（host 已脱敏）
  it('item.argsPreview 在时渲染参数预览行（zh 词条）', async () => {
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_prev', argsPreview: 'curl https://api.example.com/v1 · Bearer ***REDACTED***' }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-args-preview')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-args-preview').textContent).toBe(
      '参数：curl https://api.example.com/v1 · Bearer ***REDACTED***',
    );
  });

  it('item.argsPreview 在时渲染参数预览行（en 词条）', async () => {
    i18nState.language = 'en';
    listParkedApprovals.mockResolvedValue([
      makeParked({ id: 'perm_prev', argsPreview: 'curl https://api.example.com/v1 · Bearer ***REDACTED***' }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-args-preview')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-args-preview').textContent).toBe(
      'Arguments: curl https://api.example.com/v1 · Bearer ***REDACTED***',
    );
  });

  it('item.argsPreview 缺省（老行）不渲染参数预览行', async () => {
    listParkedApprovals.mockResolvedValue([makeParked({ id: 'perm_noprev' })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
    });
    expect(screen.queryByTestId('parked-args-preview')).toBeNull();
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

// ── 并入自 cronPendingReviewCountParity.test.tsx（gates-fast 12 文件上限，收编进同面文件）──
// 页首「待过目」tile 与收件箱标题都走 countPendingReview（按任务折算）。
// 同一任务两条记录 → 两处都显示 1。
const parityRecords: SessionAutomationRecord[] = [
  {
    id: 'review-a',
    sourceSessionId: null,
    type: 'cron',
    status: 'active',
    title: '每日周报',
    resultSessionId: 'run-a',
    config: { pendingReview: { resultSessionId: 'run-a', at: 1 } },
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'review-b',
    sourceSessionId: null,
    type: 'cron',
    status: 'active',
    title: '每日周报',
    resultSessionId: 'run-b',
    config: { pendingReview: { resultSessionId: 'run-b', at: 2 } },
    createdAt: 1,
    updatedAt: 1,
  },
];

const paritySessionsById = {
  'run-a': { origin: { kind: 'cron' as const, id: 'job-1' } },
  'run-b': { origin: { kind: 'cron' as const, id: 'job-1' } },
};

describe('pending review count parity', () => {
  beforeEach(() => {
    listPendingReview.mockResolvedValue(parityRecords);
    countPendingReview.mockResolvedValue(countPendingReviewByTask(parityRecords, paritySessionsById));
    ipcInvokeDomain.mockResolvedValue({
      scopes: { unattended: { currentCost: 0, maxBudget: 1, usagePercentage: 0 } },
    });
    useCronStore.setState({
      jobs: [],
      stats: { jobsByStatus: { running: 0 }, successRate: 100 } as never,
      latestExecutions: {},
      executionsByJobId: {},
      selectedJobId: null,
      filterMode: 'all',
      searchQuery: '',
      isLoading: false,
      isEditorOpen: false,
      editingJobId: null,
      error: null,
      recentExecutions: [],
    });
  });

  it('shows 1 on the tile and the inbox title when two records belong to one task', async () => {
    expect(countPendingReviewByTask(parityRecords, paritySessionsById)).toBe(1);
    render(<CronCenterPanel onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('cron-status-pending').querySelector('.text-2xl')?.textContent).toBe('1');
      expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('1 条待过目');
    });
    expect(screen.getAllByTestId('automation-review-item')).toHaveLength(2);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).not.toContain('2 条');
  });
});

// ── Rework r1（N-CRON-UNATTENDED-BASH-PARK-STUCK-VISIBLE）：常驻收件箱只在挂载时拉
// listParkedApprovals；停车发生在面板开着时，徽章亮了但收件箱还是旧快照，「去处理」
// 落到不含该审批的收件箱。修复：面板把等批准集合指纹作为 refreshSignal 传入，指纹变化
// 收件箱即重拉。本用例走真收件箱 + 真面板（本文件 CronJobList/Detail 打桩、收件箱不打桩）。
describe('awaiting-approval refresh signal (Rework r1)', () => {
  it('面板开着时停车出现：等批准轮询发现后，收件箱不重挂载也拉到该审批卡', async () => {
    awaitingRunsMock.value = [];
    vi.mocked(cronClient.listJobs).mockResolvedValue([
      {
        id: 'job-1',
        name: '每日晨报',
        scheduleType: 'every',
        schedule: { type: 'every', interval: 1, unit: 'days' },
        action: { type: 'agent', agentType: 'default', prompt: 'x' },
        runsOn: 'local',
        enabled: true,
      },
    ] as never);
    // latestExecutions 里 job-1 有一条 running（挂载刷新即拉），等批准轮询门因此打开
    vi.mocked(cronClient.getExecutions).mockImplementation(async (jobId: string) =>
      jobId === 'job-1'
        ? [{ id: 'exec-1', jobId: 'job-1', status: 'running', scheduledAt: 1, startedAt: 1, retryAttempt: 0 }]
        : []);
    // 收件箱挂载首拉没有这条审批；等批准指纹变化触发重拉后才给
    listParkedApprovals.mockResolvedValueOnce([]).mockResolvedValue([makeParked({})]);

    render(<CronCenterPanel onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-inbox')).toBeTruthy();
    });
    expect(screen.queryByTestId('parked-approval-item')).toBeNull();

    // 停车发生：下一轮轮询拿到该运行 → 面板指纹变化 → 收件箱原地重拉（不重挂载）
    awaitingRunsMock.value = [{ jobId: 'job-1', executionId: 'exec-1', requestId: 'req-1', requestedAt: 1 }];
    await waitFor(
      () => {
        expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
      },
      { timeout: 4000 },
    );
    expect(listParkedApprovals.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// N-CRON-REVIEW-COUNT-LIVE：页面停着时数字自动刷新，服务掉线不显示假 0。
describe('live refresh (N-CRON-REVIEW-COUNT-LIVE)', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });
  const tick = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  it('一个轮询间隔后标题与 onPendingCountChange 无需重挂载即更新', async () => {
    listPendingReview.mockResolvedValue([makeRecord({ id: 'a1' })]);
    countPendingReview.mockResolvedValue(1);
    const onChange = vi.fn();
    render(<AutomationReviewInbox onPendingCountChange={onChange} />);
    await tick(0);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('1');

    listPendingReview.mockResolvedValue([makeRecord({ id: 'a1' }), makeRecord({ id: 'a2', title: '新结果' })]);
    countPendingReview.mockResolvedValue(2);
    await tick(10_000);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('2');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('请求失败保留上次值、从不回报 0，恢复后下一次刷新', async () => {
    listPendingReview.mockResolvedValue([makeRecord({ id: 'a1' })]);
    countPendingReview.mockResolvedValue(4);
    const onChange = vi.fn();
    render(<AutomationReviewInbox onPendingCountChange={onChange} />);
    await tick(0);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('4');

    listPendingReview.mockRejectedValue(new Error('Load failed'));
    countPendingReview.mockRejectedValue(new Error('Load failed'));
    listParkedApprovals.mockRejectedValue(new Error('Load failed'));
    await tick(10_000);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('4');
    expect(onChange).not.toHaveBeenCalledWith(0);

    listPendingReview.mockResolvedValue([makeRecord({ id: 'a1' })]);
    countPendingReview.mockResolvedValue(5);
    listParkedApprovals.mockResolvedValue([]);
    await tick(10_000);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('5');
  });

  it('页面隐藏时暂停轮询，切回可见立即重拉；卸载后不再请求', async () => {
    listPendingReview.mockResolvedValue([makeRecord({ id: 'a1' })]);
    countPendingReview.mockResolvedValue(1);
    const { unmount } = render(<AutomationReviewInbox />);
    await tick(0);

    setVisibility('hidden');
    const before = listPendingReview.mock.calls.length;
    await tick(30_000);
    expect(listPendingReview.mock.calls.length).toBe(before);

    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick(0);
    expect(listPendingReview.mock.calls.length).toBe(before + 1);

    unmount();
    const afterUnmount = listPendingReview.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await tick(30_000);
    expect(listPendingReview.mock.calls.length).toBe(afterUnmount);
  });
});
