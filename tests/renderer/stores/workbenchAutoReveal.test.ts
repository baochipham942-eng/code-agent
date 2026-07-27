// 右栏「按需出现」的三条契约，互相之间是会打架的，必须一起钉：
//   A. 产品默认收起（2026-07-27 审美关）——新会话不该一上来就占三分之一屏
//   B. 任务开跑要把右栏带出来（2026-07-27 产品负责人拍板的例外）
//   C. #700：用户**自己按过**收起之后，活动信号不许把它弹回来
// A + B 单看会推翻 C；靠 workbenchCollapsedByUser 把「产品默认收起」和「用户意图收起」分开。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as Record<string, unknown>).window = {
    domainAPI: { invoke: vi.fn().mockResolvedValue(undefined) },
    electronAPI: { invoke: vi.fn().mockResolvedValue(undefined), on: vi.fn(() => () => {}), off: vi.fn() },
    dispatchEvent: vi.fn(),
  };
  useAppStore.setState({
    workbenchCollapsed: true,
    workbenchCollapsedByUser: false,
    workbenchTabs: [],
    activeWorkbenchTab: null,
    taskWorkbenchActivityActive: false,
    taskWorkbenchOpenSource: null,
  });
});

describe('右栏按需出现', () => {
  it('A：初值就是收起，且不是「用户按的」', () => {
    const initial = useAppStore.getInitialState();
    expect(initial.workbenchCollapsed).toBe(true);
    expect(initial.workbenchCollapsedByUser).toBe(false);
  });

  it('B：产品默认收起态下，任务开跑把右栏带出来', () => {
    useAppStore.getState().syncTaskWorkbenchForActivity(true);
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    // 'task' 已退役，resolveWorkbenchDeepLink 把它重定向到 'overview'（workbenchViews.ts:37-39）
    expect(useAppStore.getState().workbenchTabs).toContain('overview');
  });

  it('C：用户自己按过收起之后，任务开跑不许把它弹回来（#700）', () => {
    useAppStore.getState().setWorkbenchCollapsed(true);
    expect(useAppStore.getState().workbenchCollapsedByUser).toBe(true);

    useAppStore.getState().syncTaskWorkbenchForActivity(true);
    expect(useAppStore.getState().workbenchCollapsed).toBe(true);
  });

  it('用户重新展开后，「按过收起」的意图清掉，活动信号恢复可弹', () => {
    useAppStore.getState().setWorkbenchCollapsed(true);
    useAppStore.getState().setWorkbenchCollapsed(false);
    expect(useAppStore.getState().workbenchCollapsedByUser).toBe(false);

    useAppStore.setState({ workbenchCollapsed: true, workbenchTabs: [], taskWorkbenchActivityActive: false });
    useAppStore.getState().syncTaskWorkbenchForActivity(true);
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
  });

  it('用户主动开一个视图，无论之前是不是自己收的都展开', () => {
    useAppStore.getState().setWorkbenchCollapsed(true);
    useAppStore.getState().openWorkbenchTab('files', { source: 'user' });
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
  });
});
