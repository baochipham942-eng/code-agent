// ============================================================================
// N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU2 —— 设置页返回落点（Stripe portal return_url 模式）：
// ②-store 从自动化 webhook 门「去设置」= openSettingsWithReturn('general','cronCenter')；
//    用户关闭（closeSettings）直接回自动化页（showCronCenter 复位），暂存草稿不被作废。
// ③ 非返回关闭（setShowSettings(false)）照旧落到聊天首页，返回落点被清。
// ④ 放弃路径：非返回关闭 / 深链去能力中心时，暂存草稿作废——之后「新建任务」给全新空白草稿。
// X 关闭 / Esc 关闭走 closeSettings 的接线分别在 cronSettingsReturn.test.tsx 与
// useKeyboardShortcuts.test.tsx 钉。
// ============================================================================
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import {
  discardCronEditorDraft,
  stashCronEditorDraft,
  takeCronEditorDraft,
} from '../../../src/renderer/components/features/cron/cronEditorDraftStash';
import { createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';

function webhookDraft() {
  const draft = createDefaultCronJobDraft();
  draft.name = '我的 webhook 任务';
  draft.scheduleType = 'event-webhook';
  return draft;
}

beforeEach(() => {
  useAppStore.setState({
    showSettings: false,
    settingsReturnTo: null,
    settingsInitialTab: null,
    showCronCenter: false,
    showCapabilityHub: false,
  });
  discardCronEditorDraft();
});

describe('openSettingsWithReturn / closeSettings（返回落点）', () => {
  it('带落点打开：关设置直接回自动化页，暂存草稿留给编辑器取回', () => {
    stashCronEditorDraft(webhookDraft());
    useAppStore.setState({ showCronCenter: true }); // 去设置前自动化页就在
    useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');

    const opened = useAppStore.getState();
    expect(opened.showSettings).toBe(true);
    expect(opened.settingsReturnTo).toBe('cronCenter');
    expect(opened.settingsInitialTab).toBe('general');

    useAppStore.getState().closeSettings();
    const closed = useAppStore.getState();
    expect(closed.showSettings).toBe(false);
    expect(closed.showCronCenter).toBe(true);
    expect(closed.settingsReturnTo).toBeNull();
    // 草稿没被作废：重开的编辑器能取回（回到自动化页的意义就在这）
    expect(takeCronEditorDraft()?.name).toBe('我的 webhook 任务');
  });

  it('不带落点关闭：与 setShowSettings(false) 等价，落到聊天首页', () => {
    useAppStore.getState().setShowSettings(true);
    useAppStore.getState().closeSettings();
    const closed = useAppStore.getState();
    expect(closed.showSettings).toBe(false);
    expect(closed.showCronCenter).toBe(false);
    expect(closed.settingsReturnTo).toBeNull();
  });
});

describe('非返回关闭（setShowSettings(false)）', () => {
  it('照旧落到聊天首页并清返回落点（引导完成 / 邀专家等入口不受影响）', () => {
    useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');
    useAppStore.setState({ showCronCenter: true });

    useAppStore.getState().setShowSettings(false);
    const state = useAppStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.showCronCenter).toBe(false); // SECONDARY_PAGES_CLOSED 语义原样
    expect(state.settingsReturnTo).toBeNull();
  });

  it('清落点时作废暂存草稿：之后的「新建任务」给全新空白草稿（不旧账重提）', () => {
    stashCronEditorDraft(webhookDraft());
    useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');

    useAppStore.getState().setShowSettings(false);
    expect(takeCronEditorDraft()).toBeNull();
  });
});

describe('其它离开设置的路径', () => {
  it('设置内深链去能力中心：同样作废返回落点与草稿', () => {
    stashCronEditorDraft(webhookDraft());
    useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');

    useAppStore.getState().openCapabilityHub('connectors');
    const state = useAppStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.showCapabilityHub).toBe(true);
    expect(state.settingsReturnTo).toBeNull();
    expect(takeCronEditorDraft()).toBeNull();
  });

  it('设置内深链直达自动化：落点清掉但草稿保留（编辑器重开照常取回）', () => {
    stashCronEditorDraft(webhookDraft());
    useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');

    useAppStore.getState().openSettingsTab('automation');
    const state = useAppStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.showCronCenter).toBe(true);
    expect(state.settingsReturnTo).toBeNull();
    expect(takeCronEditorDraft()?.name).toBe('我的 webhook 任务');
  });

  it('无返回落点的普通打开不产生落点（SidebarAccountMenu / 快捷键照旧）', () => {
    useAppStore.getState().setShowSettings(true);
    expect(useAppStore.getState().settingsReturnTo).toBeNull();
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().showCronCenter).toBe(false);
  });
});
