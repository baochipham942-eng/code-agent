// @vitest-environment jsdom
// ============================================================================
// N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU2 —— 「去设置」往返的关闭落点（组件接线）：
// ②a X 关闭：编辑器门「去设置」→ 配好云端 → 点设置页 X → 直接回自动化页，
//     编辑器重开且带着暂存草稿（不重填表单、不重新找「自动化」入口）。
// ②c 非返回关闭照旧落聊天（store 级语义见 appStore.settingsReturn.test.ts）。
// ②d 放弃路径：非返回关闭后「新建任务」给全新空白草稿，暂存的半份表单不再冒出来。
// Esc 关闭的接线（useKeyboardShortcuts → closeSettings）在 useKeyboardShortcuts.test.tsx。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
// 空白草稿落在「简单创建」视图：角色/项目列表给它喂空集合即可
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/projectClient', () => ({ listProjects: vi.fn().mockResolvedValue([]) }));

// 设置页外壳轻量化：本测试只点 X，不验内容（内容有各自的 settings*.test）
vi.mock('../../../src/renderer/components/features/settings/SettingsSearch', () => ({
  SettingsSearch: () => null,
}));
vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  SettingsSectionSlotHost: () => null,
}));
vi.mock('../../../src/renderer/components/composites/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));
vi.mock('../../../src/renderer/components/UpdateNotification', () => ({
  UpdateNotification: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/tabs/GeneralSettings', () => ({
  GeneralSettings: () => <div data-testid="stub-general-settings" />,
}));

import { SettingsModal } from '../../../src/renderer/components/features/settings/SettingsModal';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { discardCronEditorDraft } from '../../../src/renderer/components/features/cron/cronEditorDraftStash';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const domainApi = vi.hoisted(() => ({ invoke: vi.fn() }));
const settingsState = { baseUrl: '', maskedToken: '' };

function controlForLabel(label: string | RegExp): HTMLInputElement | HTMLSelectElement {
  const control = screen.getByText(label).parentElement?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no control for ${label}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

/** 编辑器表单里填一个半成品 webhook 草稿，再点「去设置」（与真 UI 同一路径） */
async function fillDraftAndGotoSettings(): Promise<void> {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('手动配置'));
  await waitFor(() => expect(screen.getByText('调度方式')).toBeTruthy());
  fireEvent.change(controlForLabel('任务名称'), { target: { value: '我的 webhook 任务' } });
  fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event-webhook' } });
  fireEvent.click(await screen.findByTestId('cron-webhook-goto-settings'));
}

beforeEach(() => {
  vi.clearAllMocks();
  discardCronEditorDraft(); // 暂存是模块级单值：上一条用例的遗留会让下一条开局就是半份表单
  settingsState.baseUrl = '';
  settingsState.maskedToken = '';
  ipc.invokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'get') return settingsState.baseUrl ? { cronCloud: { baseUrl: settingsState.baseUrl } } : {};
    if (action === 'getAllServiceKeys') return settingsState.maskedToken ? { 'neo-cron-cloud': settingsState.maskedToken } : {};
    return undefined;
  });
  ipc.invoke.mockResolvedValue(undefined);
  (window as unknown as { domainAPI: unknown }).domainAPI = domainApi;
  useAppStore.setState({ language: 'zh' });
  // 真实流：用户在自动化页开着编辑器（isEditorOpen 留在 cronStore），设置页只是盖在上面
  useCronStore.setState({
    jobs: [], isEditorOpen: true, editingJobId: null, copyingJobId: null,
    createJob: vi.fn(), updateJob: vi.fn(), deleteJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
});

describe('②a X 关闭带返回落点：直接回自动化页，编辑器带草稿重开', () => {
  it('去设置 → 配好云端 → 点 X → showCronCenter 复位，重开的编辑器取回半份表单', async () => {
    useAppStore.setState({ showCronCenter: true });
    await fillDraftAndGotoSettings();
    expect(useAppStore.getState().showSettings).toBe(true);
    expect(useAppStore.getState().settingsReturnTo).toBe('cronCenter');

    cleanup(); // 设置页盖住自动化：面板连编辑器一起卸载（App.tsx 三元同款）
    settingsState.baseUrl = 'https://cloud.example.test';
    settingsState.maskedToken = 'tok-1234...';
    render(<SettingsModal />);
    fireEvent.click(screen.getByLabelText('关闭'));

    const state = useAppStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.showCronCenter).toBe(true); // 不是聊天首页：直接回到自动化
    expect(state.settingsReturnTo).toBeNull();

    render(<CronJobEditor isOpen={useCronStore.getState().isEditorOpen} job={null} onClose={() => undefined} />);
    await waitFor(() => expect(controlForLabel('任务名称').value).toBe('我的 webhook 任务'));
    expect(controlForLabel('调度类型').value).toBe('event-webhook');
    // 已配置：门消失，保存可点
    await waitFor(() => expect(screen.queryByTestId('cron-webhook-gate')).toBeNull());
    expect((screen.getByText('创建任务').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('「返回应用」按钮同路：也走 closeSettings 带落点返回', async () => {
    await fillDraftAndGotoSettings();
    cleanup();
    render(<SettingsModal />);
    fireEvent.click(screen.getByText('返回应用'));
    expect(useAppStore.getState().showSettings).toBe(false);
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });
});

describe('②d 放弃路径：暂存草稿不复活', () => {
  it('非返回关闭后「新建任务」给全新空白草稿（不含旧表单内容）', async () => {
    await fillDraftAndGotoSettings();
    cleanup();

    // 用户从设置去了别处（邀专家等）：不带返回落点的关闭
    useAppStore.getState().setShowSettings(false);
    expect(useAppStore.getState().showCronCenter).toBe(false); // 落聊天

    // 之后重新进自动化点「新建任务」
    useCronStore.getState().openCreateEditor();
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('手动配置')).toBeTruthy());
    expect(document.body.textContent).not.toContain('我的 webhook 任务');
    fireEvent.click(screen.getByText('手动配置'));
    await waitFor(() => expect(screen.getByText('调度方式')).toBeTruthy());
    expect((controlForLabel('任务名称') as HTMLInputElement).value).toBe('');
    expect((controlForLabel('调度类型') as HTMLSelectElement).value).not.toBe('event-webhook');
  });
});

describe('编辑器门接线：去设置走 openSettingsWithReturn', () => {
  it('goto-settings 后 settingsReturnTo=cronCenter 且 settingsInitialTab=general', async () => {
    await fillDraftAndGotoSettings();
    const state = useAppStore.getState();
    expect(state.settingsInitialTab).toBe('general');
    expect(state.settingsReturnTo).toBe('cronCenter');
  });
});
