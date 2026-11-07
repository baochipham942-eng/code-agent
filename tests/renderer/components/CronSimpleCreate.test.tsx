// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const createJob = vi.fn();

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    createJob: (input: unknown) => createJob(input),
  },
}));

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}));

import {
  CronSimpleCreate,
  buildSimpleDraft,
  compileSimpleSchedule,
} from '../../../src/renderer/components/features/cron/CronSimpleCreate';
import { buildCronJobInput, buildDraftFromJob } from '../../../src/renderer/components/features/cron/types';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 与 timeInput24.test.tsx 同款：把区域钉成 en-US 十二小时制，验证 24 小时下拉不出现 AM/PM。
function stubTwelveHourLocale(): void {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    locale: 'en-US',
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h12',
    hour12: true,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAppStore.setState({ language: 'zh' });
});

describe('compileSimpleSchedule', () => {
  it('每天 08:30 → cron 30 8 * * *', () => {
    expect(compileSimpleSchedule({ freq: 'daily', time: '08:30', weekday: '1', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '30 8 * * *' });
  });

  it('工作日 → 1-5', () => {
    expect(compileSimpleSchedule({ freq: 'weekdays', time: '18:00', weekday: '1', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '0 18 * * 1-5' });
  });

  it('每周三 → day-of-week 3', () => {
    expect(compileSimpleSchedule({ freq: 'weekly', time: '10:15', weekday: '3', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '15 10 * * 3' });
  });

  it('每隔 4 小时 → every/hours', () => {
    expect(compileSimpleSchedule({ freq: 'hourly', time: '09:00', weekday: '1', intervalHours: '4', onceAt: '' }))
      .toEqual({ scheduleType: 'every', everyInterval: '4', everyUnit: 'hours' });
  });

  it('只跑一次 → at + datetime', () => {
    expect(compileSimpleSchedule({ freq: 'once', time: '09:00', weekday: '1', intervalHours: '1', onceAt: '2026-08-01T09:00' }))
      .toEqual({ scheduleType: 'at', atDatetime: '2026-08-01T09:00' });
  });
});

describe('buildSimpleDraft', () => {
  it('组装 agent action，空名称最多保留目标前 48 字', () => {
    const goal = '每天读一遍我关注的竞品动态，整理成一份简报发给我过目';
    const draft = buildSimpleDraft(goal, '', { scheduleType: 'cron', cronExpression: '30 8 * * *' });
    expect(draft.actionType).toBe('agent');
    expect(draft.agentType).toBe('default');
    expect(draft.agentPrompt).toBe(goal);
    expect(draft.name).toBe(goal.slice(0, 48));
    // 全链路：draft 能通过 buildCronJobInput 校验并产出 agent action
    const input = buildCronJobInput(draft);
    expect(input.action).toEqual({ type: 'agent', agentType: 'default', prompt: goal, context: {} });
    expect(input.schedule).toEqual({ type: 'cron', expression: '30 8 * * *', timezone: undefined });
  });

  it('保留可选角色和归档项目，缺省为空串', () => {
    const schedule = { scheduleType: 'cron' as const, cronExpression: '0 9 * * *' };
    expect(buildSimpleDraft('整理简报', '简报', schedule, 'muzhi', 'proj_1')).toMatchObject({
      agentRoleId: 'muzhi',
      agentLibraryProjectId: 'proj_1',
    });
    expect(buildSimpleDraft('整理简报', '简报', schedule)).toMatchObject({
      agentRoleId: '',
      agentLibraryProjectId: '',
    });
  });
});

describe('buildCronJobInput agent options', () => {
  it('保留账号和会话组成的完整结果推送目标', () => {
    const draft = buildSimpleDraft(
      '整理简报',
      '简报',
      { scheduleType: 'cron', cronExpression: '0 9 * * *' },
      undefined,
      undefined,
      'local',
      '工作飞书:oc_group',
    );
    expect(buildCronJobInput(draft).resultChannel).toBe('工作飞书:oc_group');
  });

  it('传递角色与归档项目', () => {
    const draft = buildSimpleDraft('整理简报', '简报', { scheduleType: 'cron', cronExpression: '0 9 * * *' }, 'muzhi', 'proj_1');
    const action = buildCronJobInput(draft).action;
    expect(action.type).toBe('agent');
    if (action.type === 'agent') {
      expect(action.roleId).toBe('muzhi');
      expect(action.libraryProjectId).toBe('proj_1');
    }
  });

  it('空选项保持 undefined，保持既有运行语义', () => {
    const draft = buildSimpleDraft('整理简报', '简报', { scheduleType: 'cron', cronExpression: '0 9 * * *' });
    const action = buildCronJobInput(draft).action;
    expect(action.type).toBe('agent');
    if (action.type === 'agent') {
      expect(action.roleId).toBeUndefined();
      expect(action.libraryProjectId).toBeUndefined();
    }
  });
});

describe('CronSimpleCreate', () => {
  it('空目标提交显示校验提示且不调 createJob', async () => {
    render(<CronSimpleCreate onDone={() => undefined} />);
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => {
      expect(screen.getByText('先告诉我要做什么')).toBeTruthy();
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('填目标提交后走 createJob，产出 agent+cron 任务', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'new-job',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), {
      target: { value: '每天帮我盯一下竞品发布' },
    });
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.action.type).toBe('agent');
    expect(submitted.schedule).toEqual({ type: 'cron', expression: '0 9 * * *', timezone: undefined });
    expect(submitted.enabled).toBe(true);
    expect(submitted.runsOn).toBe('local');
  });

  it('常显冻结说明，并可原地展开五行本地/云端对照后创建云端任务', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'new-cloud-job',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));
    render(<CronSimpleCreate onDone={() => undefined} />);

    expect(screen.getByText('选定后不能改——想换执行位置，需要新建一个任务')).toBeTruthy();
    fireEvent.click(screen.getByText('有什么不同?'));
    const table = screen.getByTestId('cron-location-comparison');
    for (const label of ['需要 app 开着', '访问本机文件 / 已登录浏览器', '每次执行环境', '权限提示', '最小触发间隔']) {
      expect(table.textContent).toContain(label);
    }

    fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '整理云端简报' } });
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => expect(createJob).toHaveBeenCalled());
    expect(createJob.mock.calls[0][0]).toMatchObject({ runsOn: 'cloud' });
  });

  it('撞整点（默认 09:00）给错峰建议；把分钟错开后建议消失（N-CRON-RESILIENCE ②）', async () => {
    render(<CronSimpleCreate onDone={() => undefined} />);

    // 默认 daily 09:00：分钟=0，给出错峰建议（建议值 1..59 非 0）
    const hint = screen.getByTestId('cron-stagger-hint');
    expect(hint.textContent).toContain('错开到');
    const suggested = Number(hint.textContent!.match(/错开到\s*(\d+)\s*分/)?.[1]);
    expect(suggested).toBeGreaterThanOrEqual(1);
    expect(suggested).toBeLessThanOrEqual(59);

    // 分钟下拉改成 17 → 09:17：不再撞整点，建议消失
    fireEvent.change(screen.getByTestId('cron-simple-time-minute'), { target: { value: '17' } });
    expect(screen.queryByTestId('cron-stagger-hint')).toBeNull();
  });

  it('云端+角色被宿主拒绝时显示本地化原因而非英文原句', async () => {
    createJob.mockRejectedValue(new Error('Role-bound agent jobs cannot run on the cloud scheduler'));
    render(<CronSimpleCreate onDone={() => undefined} />);
    fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '整理云端简报' } });
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => expect(createJob).toHaveBeenCalled());
    expect(await screen.findByText(/只能在本机运行/)).toBeTruthy();
    expect(screen.queryByText(/Role-bound/)).toBeNull();
  });

  it('选 08:30 保存 → cron 表达式 30 8 * * *（小时/分钟下拉驱动）', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'new-job-830',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), {
      target: { value: '每天八点半盯竞品' },
    });
    fireEvent.change(screen.getByTestId('cron-simple-time-hour'), { target: { value: '08' } });
    fireEvent.change(screen.getByTestId('cron-simple-time-minute'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.schedule).toEqual({ type: 'cron', expression: '30 8 * * *', timezone: undefined });
  });

  it('en-US h12 区域下时间选择器仍是 24 小时双下拉，无 AM/PM、无原生 time 输入', () => {
    stubTwelveHourLocale();
    const { container } = render(<CronSimpleCreate onDone={() => undefined} />);

    expect(container.querySelector('input[type="time"]')).toBeNull();
    const picker = screen.getByTestId('cron-simple-time');
    const selects = picker.querySelectorAll('select');
    expect(selects.length).toBe(2);
    const hour = screen.getByTestId('cron-simple-time-hour') as HTMLSelectElement;
    const minute = screen.getByTestId('cron-simple-time-minute') as HTMLSelectElement;
    expect(hour.value).toBe('09');
    expect(minute.value).toBe('00');
    expect(document.body.textContent).not.toMatch(/AM|PM/);
  });

  it.each([
    ['zh', '紧急判据（可选）', /老板发来的邮件/, '设置后，非今日必办'],
    ['en', 'Urgency rule (optional)', /only mail from my boss/, 'With a rule set, non-urgent runs'],
  ] as const)('本地模式显示紧急判据字段（%s）', (language, label, placeholder, hint) => {
    useAppStore.setState({ language });
    render(<CronSimpleCreate onDone={() => undefined} />);
    const input = screen.getByTestId('cron-simple-urgency-criteria') as HTMLInputElement;
    expect(screen.getByText(label)).toBeTruthy();
    expect(input.placeholder).toMatch(placeholder);
    expect(document.body.textContent).toContain(hint);
  });

  async function submitWith(goalText: string, urgency?: string, cloudFirst = false) {
    createJob.mockImplementation(async (input) => ({
      ...(input as object), id: 'j', createdAt: 1, updatedAt: 1,
    } as CronJobDefinition));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: goalText } });
    if (urgency !== undefined) {
      fireEvent.change(screen.getByTestId('cron-simple-urgency-criteria'), { target: { value: urgency } });
    }
    if (cloudFirst) fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return createJob.mock.calls[0][0] as CronJobDefinition;
  }

  it('填写判据 → createJob action 带 trim 后的 urgencyCriteria，且能回读到编辑器 draft', async () => {
    const submitted = await submitWith('盯邮件', '  只有老板发来的邮件算今天必须处理  ');
    expect(submitted.action).toMatchObject({ type: 'agent', urgencyCriteria: '只有老板发来的邮件算今天必须处理' });
    const loaded = buildDraftFromJob({ ...submitted, id: 'j', createdAt: 1, updatedAt: 1 });
    expect(loaded.agentUrgencyCriteria).toBe('只有老板发来的邮件算今天必须处理');
  });

  it('留空 → action 没有 urgencyCriteria 键', async () => {
    const submitted = await submitWith('盯邮件');
    expect(submitted.action).toHaveProperty('urgencyCriteria', undefined);
    // 线上序列化后键不存在
    expect(Object.keys(JSON.parse(JSON.stringify(submitted.action)))).not.toContain('urgencyCriteria');
  });

  it('选云端 → 字段隐藏，且先前输入的判据不进 payload', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object), id: 'j', createdAt: 1, updatedAt: 1,
    } as CronJobDefinition));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '云端简报' } });
    fireEvent.change(screen.getByTestId('cron-simple-urgency-criteria'), { target: { value: '只看老板' } });
    fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    expect(screen.queryByTestId('cron-simple-urgency-criteria')).toBeNull();
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.runsOn).toBe('cloud');
    expect(submitted.action).toHaveProperty('urgencyCriteria', undefined);
    // 线上序列化后键不存在
    expect(Object.keys(JSON.parse(JSON.stringify(submitted.action)))).not.toContain('urgencyCriteria');
  });
});
