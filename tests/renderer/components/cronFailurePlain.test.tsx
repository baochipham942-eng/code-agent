// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';
import { classifyCronFailure } from '../../../src/shared/utils/cronFailureClassification';
import {
  CRON_CLOUD_UNAVAILABLE_MESSAGE_EN,
  CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH,
} from '../../../src/shared/utils/cronCloudUnavailable';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { translateCronOsNotification } from '../../../src/renderer/components/features/cron/cronFailureNotice';
import { CronCloudRuntime } from '../../../src/host/cron/cronCloudRuntime';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';

const GLM_WITH_FLUSH = [
  '429 Too Many Requests',
  '{"error":{"code":"1308","message":"usage limit reached for the 5-hour window","next_flush_time":"2026-10-15T05:00:00Z"}}',
].join('\n');
const GLM_WITHOUT_FLUSH = '{"error":{"code":"1308","message":"usage limit reached"}}';
const BALANCE = '402 Payment Required: insufficient balance';

/**
 * 真实落库路径：CronCloudRuntime.recordFailure 在 fetch 打不通时写下的 execution。
 * unavailableMessage 的接法与 cronService 相同（按语言返回固定句），拿到的就是
 * 会进执行历史的原始记录——error 不手拼，详情页读到什么就验什么。
 */
async function recordedCloudFailure(language: 'zh' | 'en'): Promise<CronJobExecution> {
  const executions: CronJobExecution[] = [];
  const failingFetch = vi.fn(async () => {
    throw new Error('fetch failed');
  });
  const runtime = new CronCloudRuntime(
    () => ({ baseUrl: 'https://cron.example.test', token: 'secret-token' }),
    {
      getJobs: () => [],
      persistJob: async () => {},
      persistExecution: async (record) => { executions.push(record); },
      loadExecutionStatus: () => undefined,
      onCompleted: async () => {},
      unavailableMessage: () => (language === 'en'
        ? CRON_CLOUD_UNAVAILABLE_MESSAGE_EN
        : CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH),
    },
    failingFetch as unknown as typeof fetch,
  );
  const definition: CronJobDefinition = {
    id: 'cloud-down-job-1',
    name: 'Cloud digest',
    runsOn: 'cloud',
    scheduleType: 'at',
    schedule: { type: 'at', datetime: 2_000_000 },
    action: { type: 'agent', agentType: 'default', prompt: 'Say hi.' },
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  };
  await runtime.addJob(definition);
  const [record] = executions;
  if (!record) throw new Error('recordFailure did not persist an execution');
  return record;
}

const originalOpen = useAppStore.getState().openSettingsTab;
const originalTrigger = useCronStore.getState().triggerJob;

function execution(error: string, runsOn: 'local' | 'cloud' = 'local'): CronJobExecution {
  return {
    id: 'execution-1',
    jobId: 'job-1',
    runsOn,
    status: 'failed',
    scheduledAt: 1,
    startedAt: 1,
    completedAt: 2,
    duration: 1,
    retryAttempt: 0,
    sessionId: 'session-1',
    error,
  };
}

function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', openSettingsTab: originalOpen });
  useCronStore.setState({ triggerJob: originalTrigger });
});

describe('cron failure notification copy', () => {
  const now = new Date(2026, 9, 14, 8, 0, 0);
  const samples = [
    ['quota-flush', GLM_WITH_FLUSH],
    ['quota-plain', GLM_WITHOUT_FLUSH],
    ['balance', BALANCE],
    ['rate', '429 Too Many Requests'],
    ['timeout', 'request timed out'],
    ['auth', '401 Unauthorized: incorrect api key'],
    ['network', 'fetch failed'],
    ['cloud-down', CRON_CLOUD_UNAVAILABLE_MESSAGE_EN],
    ['other', 'something exploded in the runner'],
  ] as const;

  it.each(samples)('zh/en 通知文案跟分类走：%s', (_label, error) => {
    const classified = classifyCronFailure(error);
    const zh = translateCronOsNotification({
      code: 'CRON_FAILURE',
      title: '任务失败 - [定时] 整理邮件',
      body: `定时任务失败：${error}`,
      failureKind: classified.kind,
      resetAt: classified.resetAt,
    }, cronCenterZh.cronCenter, 'zh', now);
    const en = translateCronOsNotification({
      code: 'CRON_FAILURE',
      title: '任务失败 - [定时] 整理邮件',
      body: `定时任务失败：${error}`,
      failureKind: classified.kind,
      resetAt: classified.resetAt,
    }, cronCenterEn.cronCenter, 'en', now);

    expect(zh.title).toBe('定时任务没跑成 · 整理邮件');
    expect(en.title).toBe("Scheduled task didn't finish · 整理邮件");
    expect(zh.body).toBe(sentenceFor(cronCenterZh.cronCenter, classified.kind, classified.resetAt, 'zh'));
    expect(en.body).toBe(sentenceFor(cronCenterEn.cronCenter, classified.kind, classified.resetAt, 'en'));
    if (classified.kind === 'quota' && !classified.resetAt) {
      expect(zh.body).toContain('以服务商为准');
      expect(zh.body).not.toMatch(/\d{2}:\d{2}/);
    }
    if (classified.resetAt) {
      expect(zh.body).toContain(clock(classified.resetAt));
      expect(zh.body).not.toContain('2026-10-15T05:00:00Z');
    }
  });

  it('云端调度器不可用：OS 通知按语言出人话', () => {
    const zh = translateCronOsNotification({
      code: 'CRON_FAILURE',
      title: '任务失败 - [定时] 整理邮件',
      body: `定时任务失败：${CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH}`,
      failureKind: 'cloud_unavailable',
    }, cronCenterZh.cronCenter, 'zh');
    const en = translateCronOsNotification({
      code: 'CRON_FAILURE',
      title: '任务失败 - [定时] 整理邮件',
      body: `定时任务失败：${CRON_CLOUD_UNAVAILABLE_MESSAGE_EN}`,
      failureKind: 'cloud_unavailable',
    }, cronCenterEn.cronCenter, 'en');
    expect(zh.body).toBe('云端定时服务暂时连不上，这次任务没有执行。');
    expect(en.body).toBe("The cloud scheduler can't be reached right now, so this run didn't happen.");
  });

  it('登录墙译文保持原句，不走失败分类', () => {
    const notice = translateCronOsNotification({
      code: 'CRON_LOGIN_WALL_STOP',
      title: '任务失败 - [定时] 整理邮件',
      body: 'fallback',
      siteOrigin: 'https://example.test',
    }, cronCenterZh.cronCenter, 'zh');
    expect(notice).toEqual({
      title: '需要重新登录',
      body: '请在 Neo 浏览器中登录 https://example.test，然后下一次定时运行才能继续。',
    });
  });

  it('不认识的通知保持 host 原文', () => {
    expect(translateCronOsNotification({
      code: undefined,
      title: '任务完成 - [定时] 整理邮件',
      body: '定时任务已完成',
    }, cronCenterZh.cronCenter, 'zh')).toEqual({
      title: '任务完成 - [定时] 整理邮件',
      body: '定时任务已完成',
    });
  });
});

describe('CronExecutionDetail 人话失败', () => {
  it('本机和云端同一条错误得到同一句人话', () => {
    useAppStore.setState({ language: 'zh' });
    const { unmount } = render(<CronExecutionDetail execution={execution(GLM_WITH_FLUSH, 'local')} runsOn="local" />);
    const local = screen.getByTestId('cron-failure-sentence').textContent;
    expect(screen.getByTestId('cron-runs-on-pill-local').textContent).toContain('本地');
    unmount();
    render(<CronExecutionDetail execution={execution(GLM_WITH_FLUSH, 'cloud')} runsOn="cloud" />);
    expect(screen.getByTestId('cron-failure-sentence').textContent).toBe(local);
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');
    expect(local).toContain(clock('2026-10-15T05:00:00.000Z'));
    expect(local).toContain('5-hour window');
  });

  it('有重置时间、没有重置时间、402 余额三条额度文案', () => {
    useAppStore.setState({ language: 'zh' });
    const first = render(<CronExecutionDetail execution={execution(GLM_WITH_FLUSH)} />);
    expect(screen.getByTestId('cron-failure-sentence').textContent).toContain('预计');
    expect(screen.getByTestId('cron-failure-sentence').textContent).toContain(clock('2026-10-15T05:00:00.000Z'));
    expect(screen.getByTestId('cron-failure-action').textContent).toContain('换个模型');
    expect((screen.getByTestId('cron-failure-technical') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('cron-failure-technical').textContent).toContain('1308');
    first.unmount();

    const second = render(<CronExecutionDetail execution={execution(GLM_WITHOUT_FLUSH)} />);
    expect(screen.getByTestId('cron-failure-sentence').textContent).toBe('模型额度/余额用完了。恢复时间以服务商为准');
    second.unmount();

    render(<CronExecutionDetail execution={execution(BALANCE)} />);
    expect(screen.getByTestId('cron-failure-sentence').textContent).toBe('模型额度/余额用完了。恢复时间以服务商为准');
    expect(screen.getByTestId('cron-failure-sentence').textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  it.each([
    ['429 Too Many Requests', '服务商暂时限流，下次运行会自动再试', '立即重跑'],
    ['request timed out', '这次运行超时被停了', '立即重跑'],
    ['fetch failed', '暂时连不上模型服务', '立即重跑'],
    ['401 Unauthorized: incorrect api key', '模型账号没通过授权（密钥错误或已过期）', '检查账号设置'],
    ['something exploded in the runner', '运行失败', null],
  ] as const)('详情下一步：%s', (error, sentence, action) => {
    useAppStore.setState({ language: 'zh' });
    render(<CronExecutionDetail execution={execution(error)} />);
    expect(screen.getByTestId('cron-failure-sentence').textContent).toBe(sentence);
    if (action) {
      expect(screen.getByTestId('cron-failure-action').textContent).toContain(action);
    } else {
      expect(screen.queryByTestId('cron-failure-action')).toBeNull();
      expect(screen.getByText('打开会话')).toBeTruthy();
    }
  });

  it('云端调度器不可用：真实 recordFailure 落库报文 → 一句话 + 立即重跑', async () => {
    const triggerJob = vi.fn().mockResolvedValue(null);
    useCronStore.setState({ triggerJob });

    useAppStore.setState({ language: 'zh' });
    const zhExecution = await recordedCloudFailure('zh');
    expect(zhExecution.error).toBe(CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH);
    const { unmount } = render(<CronExecutionDetail execution={zhExecution} runsOn="cloud" />);
    expect(screen.getByTestId('cron-failure-sentence').textContent)
      .toBe('云端定时服务暂时连不上，这次任务没有执行。');
    expect(screen.getByTestId('cron-failure-action').textContent).toContain('立即重跑');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-failure-action'));
    });
    expect(triggerJob).toHaveBeenCalledWith('cloud-down-job-1');
    // 原始报文仍收在技术详情里，排查线索不丢
    expect(screen.getByTestId('cron-failure-technical').textContent)
      .toContain(CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH);
    unmount();

    useAppStore.setState({ language: 'en' });
    const enExecution = await recordedCloudFailure('en');
    render(<CronExecutionDetail execution={enExecution} runsOn="cloud" />);
    expect(screen.getByTestId('cron-failure-sentence').textContent)
      .toBe("The cloud scheduler can't be reached right now, so this run didn't happen.");
    expect(screen.getByTestId('cron-failure-action').textContent).toContain('Run again now');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-failure-action'));
    });
    expect(triggerJob).toHaveBeenCalledWith('cloud-down-job-1');
  });

  it('换个模型打开模型设置，立即重跑复用 triggerJob', async () => {
    const openSettingsTab = vi.fn();
    const triggerJob = vi.fn().mockResolvedValue(null);
    useAppStore.setState({ language: 'zh', openSettingsTab });
    useCronStore.setState({ triggerJob });

    const { unmount } = render(<CronExecutionDetail execution={execution(GLM_WITHOUT_FLUSH)} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-failure-action'));
    });
    expect(openSettingsTab).toHaveBeenCalledWith('model');
    unmount();

    render(<CronExecutionDetail execution={execution('429 Too Many Requests')} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-failure-action'));
    });
    expect(triggerJob).toHaveBeenCalledWith('job-1');
  });

  it('登录墙提供 Neo 浏览器登录和立即重跑动作', async () => {
    useAppStore.setState({ language: 'zh' });
    const triggerJob = vi.fn().mockResolvedValue(null);
    useCronStore.setState({ triggerJob });
    const { unmount } = render(
      <CronExecutionDetail execution={execution(buildCronLoginWallStopCode('https://example.test'))} />,
    );
    expect(screen.getByText('你需要在 Neo 浏览器中登录 https://example.test，这次定时运行已停止。')).toBeTruthy();
    expect(screen.getByTestId('cron-execution-open-login-site').textContent).toContain('在 Neo 浏览器中登录');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-login-wall-rerun'));
    });
    expect(triggerJob).toHaveBeenCalledWith('job-1');
    expect(screen.queryByTestId('cron-failure-plain')).toBeNull();
    unmount();

    render(<CronExecutionDetail execution={execution('unsupported_action')} />);
    expect(screen.getByText('该类任务暂不支持')).toBeTruthy();
    expect(screen.queryByTestId('cron-failure-plain')).toBeNull();
    unmount();

    render(<CronExecutionDetail execution={execution('Cloud execution is not wired yet (N-L3-MINLOOP-SRV).')} runsOn="cloud" />);
    expect(screen.getByText('云端执行尚未接线（N-L3-MINLOOP-SRV）')).toBeTruthy();
    expect(screen.queryByTestId('cron-failure-plain')).toBeNull();
  });
});

function sentenceFor(
  copy: typeof cronCenterZh.cronCenter,
  kind: ReturnType<typeof classifyCronFailure>['kind'],
  resetAt: string | undefined,
  language: 'zh' | 'en',
): string {
  if (kind === 'quota' && resetAt) {
    const when = clock(resetAt);
    const date = new Date(resetAt);
    const sameDay = date.getFullYear() === 2026 && date.getMonth() === 9 && date.getDate() === 14;
    const formatted = sameDay || language === 'en'
      ? (sameDay ? when : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${when}`)
      : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${when}`;
    return copy.failureQuotaWithReset.replace('{when}', formatted);
  }
  if (kind === 'quota') return copy.failureQuotaUnknown;
  if (kind === 'rate_limit') return copy.failureRateLimit;
  if (kind === 'timeout') return copy.failureTimeout;
  if (kind === 'auth') return copy.failureAuth;
  if (kind === 'network') return copy.failureNetwork;
  if (kind === 'cloud_unavailable') return copy.failureCloudUnavailable;
  return copy.failureOther;
}
