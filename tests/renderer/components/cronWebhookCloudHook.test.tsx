// @vitest-environment jsdom
// ============================================================================
// N-CRON-WEBHOOK-CLOUD-HOOK-FU1 —— renderer 侧四块：
// ⑤a 设置卡：令牌走 secureStorage（setServiceApiKey neo-cron-cloud）、地址进 settings
//     且 payload 里没有令牌；保存后通知主进程起流；已配置时打码 + 「更换」。
// ⑤b 编辑器门：创建菜单常驻「Webhook 投递」；云端未配置显示原因 + 去设置、保存禁用；
//     去设置前草稿被暂存，回来取回（回答「草稿能不能活过设置页」）。
// ⑤c 一次性链接卡：创建成功 -> register -> 显示完整 URL + 复制 + 警示；失败显式说明。
// ⑤d 详情块：链接已隐藏说明；重新生成先确认，调 rotate，显示新链接 + 旧链接失效提示；
//     停用态显示已吊销；云端未配置给本地化引导而非静默。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
  invokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
  invokeDomain: ipc.invokeDomain,
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastMock }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));

import { CronCloudSettingsCard } from '../../../src/renderer/components/features/settings/tabs/CronCloudSettingsCard';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { CronWebhookLinkBlock } from '../../../src/renderer/components/features/cron/CronWebhookLinkBlock';
import { CronHookError } from '../../../src/renderer/services/cronClient';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const wc = cronCenterZh.cronCenter.webhook;
const HOOK_URL_1 = 'https://relay.example.test/api/cron/hooks/job-1?token=hk_first_secret';
const HOOK_URL_2 = 'https://relay.example.test/api/cron/hooks/job-1?token=hk_second_secret';

const domainApi = vi.hoisted(() => ({ invoke: vi.fn() }));

/** settings/getAllServiceKeys 的可变桩：模拟「云端是否已配置」。 */
const settingsState = { baseUrl: '', maskedToken: '' };

function installSettingsStub() {
  ipc.invokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'get') return settingsState.baseUrl ? { cronCloud: { baseUrl: settingsState.baseUrl } } : {};
    if (action === 'getAllServiceKeys') return settingsState.maskedToken ? { 'neo-cron-cloud': settingsState.maskedToken } : {};
    return undefined;
  });
}

function webhookJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-1',
    name: 'watch sentry',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'webhook', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: 'p' },
    runsOn: 'local',
    maxRunBudget: 0.5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function controlForLabel(label: string | RegExp): HTMLInputElement | HTMLSelectElement {
  const control = screen.getByText(label).parentElement?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no control for ${label}`);
  return control as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsState.baseUrl = '';
  settingsState.maskedToken = '';
  installSettingsStub();
  ipc.invoke.mockResolvedValue(undefined);
  (window as unknown as { domainAPI: unknown }).domainAPI = domainApi;
  domainApi.invoke.mockReset();
  useAppStore.setState({ language: 'zh' });
  useCronStore.setState({
    jobs: [], isEditorOpen: false, editingJobId: null, copyingJobId: null,
    createJob: vi.fn(), updateJob: vi.fn(), deleteJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
});

describe('⑤a 设置卡', () => {
  it('地址进 settings（payload 无令牌）、令牌走 neo-cron-cloud、随后通知起流并打码回显', async () => {
    domainApi.invoke.mockResolvedValue({ success: true });
    ipc.invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'get') return settingsState.baseUrl ? { cronCloud: { baseUrl: settingsState.baseUrl } } : {};
      if (action === 'getAllServiceKeys') return settingsState.maskedToken ? { 'neo-cron-cloud': settingsState.maskedToken } : {};
      if (action === 'setServiceApiKey') { settingsState.maskedToken = 'tok-1234...'; settingsState.baseUrl = 'https://cloud.example.test'; }
      return undefined;
    });
    render(<CronCloudSettingsCard />);
    fireEvent.change(await screen.findByTestId('cron-cloud-base-url'), { target: { value: ' https://cloud.example.test/ ' } });
    fireEvent.change(screen.getByTestId('cron-cloud-token-input'), { target: { value: 'tok-1234-secret-value' } });
    fireEvent.click(screen.getByTestId('cron-cloud-save'));

    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service: 'neo-cron-cloud', apiKey: 'tok-1234-secret-value' },
    ));
    const setCall = ipc.invokeDomain.mock.calls.find(([, action]) => action === 'set');
    expect(setCall?.[2]).toEqual({ settings: { cronCloud: { baseUrl: 'https://cloud.example.test' } } });
    expect(JSON.stringify(setCall)).not.toContain('tok-1234-secret-value');
    await waitFor(() => expect(domainApi.invoke).toHaveBeenCalledWith(IPC_DOMAINS.CRON, 'ensureCloudStream', undefined));
    expect((await screen.findByTestId('cron-cloud-token-masked')).textContent).toBe('tok-1234...');
  });

  it('缺地址/缺令牌：本地化提示，不调用保存', async () => {
    render(<CronCloudSettingsCard />);
    fireEvent.click(await screen.findByTestId('cron-cloud-save'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(cronCenterZh.cronCenter.cloudSettings.baseUrlRequired));
    expect(ipc.invokeDomain.mock.calls.some(([, action]) => action === 'set' || action === 'setServiceApiKey')).toBe(false);
  });
});

describe('⑤b 编辑器门', () => {
  async function openManual(): Promise<void> {
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('手动配置'));
    await waitFor(() => expect(screen.getByText('调度方式')).toBeTruthy());
  }

  it('创建菜单常驻 Webhook 投递；云端未配置：原因 + 去设置，保存禁用', async () => {
    await openManual();
    const options = Array.from(controlForLabel('调度类型').querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toContain(cronCenterZh.cronCenter.eventWebhookScheduleOption);

    fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event-webhook' } });
    expect((await screen.findByTestId('cron-webhook-gate')).textContent).toContain(wc.gateUnconfigured);
    expect((screen.getByText('创建任务').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('去设置：草稿被暂存，编辑器重开后取回（不必重填整张表单）', async () => {
    await openManual();
    fireEvent.change(controlForLabel('任务名称'), { target: { value: '我的 webhook 任务' } });
    fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event-webhook' } });
    fireEvent.click(await screen.findByTestId('cron-webhook-goto-settings'));
    expect(useAppStore.getState().showSettings).toBe(true);

    cleanup(); // 设置页打开会卸载自动化面板，编辑器本地 state 随之消失
    settingsState.baseUrl = 'https://cloud.example.test';
    settingsState.maskedToken = 'tok-1234...';
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    await waitFor(() => expect((controlForLabel('任务名称')).value).toBe('我的 webhook 任务'));
    expect(controlForLabel('调度类型').value).toBe('event-webhook');
    // 已配置：门消失，保存可点
    await waitFor(() => expect(screen.queryByTestId('cron-webhook-gate')).toBeNull());
    expect((screen.getByText('创建任务').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('⑤c 已配置：创建成功 -> register -> 一次性链接卡（完整 URL + 复制 + 警示）', async () => {
    settingsState.baseUrl = 'https://cloud.example.test';
    settingsState.maskedToken = 'tok-1234...';
    (useCronStore.getState().createJob as Mock).mockResolvedValue(webhookJob());
    domainApi.invoke.mockResolvedValue({ success: true, data: { url: HOOK_URL_1, token: 'hk_first_secret' } });
    await openManual();
    await waitFor(() => expect(screen.queryByTestId('cron-webhook-gate')).toBeNull(), { timeout: 100 }).catch(() => undefined);

    fireEvent.change(controlForLabel('任务名称'), { target: { value: 'watch sentry' } });
    fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event-webhook' } });
    fireEvent.change(await screen.findByLabelText(/^单次预算上限/), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('执行动作'));
    fireEvent.change(controlForLabel('Agent 类型'), { target: { value: 'default' } });
    fireEvent.change(controlForLabel('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByText('创建任务'));

    const urlField = await screen.findByTestId('cron-webhook-url');
    expect((urlField as HTMLInputElement).value).toBe(HOOK_URL_1);
    expect(domainApi.invoke).toHaveBeenCalledWith(IPC_DOMAINS.CRON, 'registerWebhookHook', { jobId: 'job-1' });
    expect(screen.getByTestId('cron-webhook-warning').textContent).toContain('密码');
    expect(screen.getByTestId('cron-webhook-copy')).toBeTruthy();
    const createJob = useCronStore.getState().createJob as Mock;
    expect(createJob.mock.calls[0][0]).toMatchObject({
      scheduleType: 'event', runsOn: 'local', maxRunBudget: 0.5,
      schedule: { type: 'event', source: 'webhook' },
    });
  });

  it('⑤c register 失败：显式说明 + 可重试，不静默', async () => {
    settingsState.baseUrl = 'https://cloud.example.test';
    settingsState.maskedToken = 'tok-1234...';
    (useCronStore.getState().createJob as Mock).mockResolvedValue(webhookJob());
    domainApi.invoke.mockResolvedValue({ success: false, error: { code: 'CRON_ERROR', message: 'Cloud cron hook register failed: boom (HTTP 502)' } });
    await openManual();
    fireEvent.change(controlForLabel('任务名称'), { target: { value: 'watch sentry' } });
    fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event-webhook' } });
    fireEvent.change(await screen.findByLabelText(/^单次预算上限/), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('执行动作'));
    fireEvent.change(controlForLabel('Agent 类型'), { target: { value: 'default' } });
    fireEvent.change(controlForLabel('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByText('创建任务'));

    const failure = await screen.findByTestId('cron-webhook-failure');
    expect(failure.textContent).toContain(wc.registerFailed);
    expect(failure.textContent).toContain('HTTP 502');
    expect(screen.queryByTestId('cron-webhook-url')).toBeNull();
    expect(screen.getByTestId('cron-webhook-retry')).toBeTruthy();
  });
});

describe('⑤d 详情块', () => {
  it('启用态：说明链接已隐藏；重新生成先确认，确认后 rotate 并显示新链接 + 旧链接失效', async () => {
    domainApi.invoke.mockResolvedValue({ success: true, data: { url: HOOK_URL_2, token: 'hk_second_secret' } });
    render(<CronWebhookLinkBlock job={webhookJob()} />);
    expect(screen.getByTestId('cron-webhook-hidden').textContent).toContain(wc.blockHidden);
    expect(document.body.textContent).not.toContain('hk_first_secret');

    fireEvent.click(screen.getByTestId('cron-webhook-regenerate'));
    expect(domainApi.invoke).not.toHaveBeenCalled(); // 先确认
    fireEvent.click(await screen.findByText(wc.confirmAction, { selector: 'button' }));

    expect(((await screen.findByTestId('cron-webhook-url')) as HTMLInputElement).value).toBe(HOOK_URL_2);
    expect(domainApi.invoke).toHaveBeenCalledWith(IPC_DOMAINS.CRON, 'rotateWebhookHook', { jobId: 'job-1' });
    expect(screen.getByTestId('cron-webhook-notice').textContent).toBe(wc.regeneratedNotice);
  });

  it('停用态：说明链接已在停用时吊销，不给重新生成', () => {
    render(<CronWebhookLinkBlock job={webhookJob({ enabled: false })} />);
    expect(screen.getByTestId('cron-webhook-revoked').textContent).toContain(wc.blockRevoked);
    expect(screen.queryByTestId('cron-webhook-regenerate')).toBeNull();
  });

  it('云端未配置：给本地化引导句，不是静默失败', async () => {
    domainApi.invoke.mockResolvedValue({ success: false, error: { code: 'CRON_CLOUD_NOT_CONFIGURED', message: 'Webhook-triggered jobs require the Neo cloud scheduler to be configured' } });
    render(<CronWebhookLinkBlock job={webhookJob()} />);
    fireEvent.click(screen.getByTestId('cron-webhook-regenerate'));
    fireEvent.click(await screen.findByText(wc.confirmAction, { selector: 'button' }));
    expect((await screen.findByTestId('cron-webhook-failure')).textContent).toBe(wc.unconfigured);
  });

  it('其它失败：本地化标题 + 主机原文', async () => {
    domainApi.invoke.mockResolvedValue({ success: false, error: { code: 'CRON_ERROR', message: 'Cloud cron hook rotate failed: nope (HTTP 404)' } });
    render(<CronWebhookLinkBlock job={webhookJob()} />);
    fireEvent.click(screen.getByTestId('cron-webhook-regenerate'));
    fireEvent.click(await screen.findByText(wc.confirmAction, { selector: 'button' }));
    const text = (await screen.findByTestId('cron-webhook-failure')).textContent ?? '';
    expect(text).toContain(wc.regenerateFailed);
    expect(text).toContain('HTTP 404');
  });
});

describe('CronHookError', () => {
  it('携带主机错误码', () => {
    expect(new CronHookError('m', 'CRON_CLOUD_NOT_CONFIGURED').code).toBe('CRON_CLOUD_NOT_CONFIGURED');
  });
});
