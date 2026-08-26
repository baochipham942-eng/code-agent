import type { StoreApi } from 'zustand';
import { noteSurfaceIntentNavigation } from '../services/surfaceIntentRuntime';
import { surfaceIntentViewForWorkbenchTab } from '../utils/surfaceIntent';
import {
  isPreviewWorkbenchView,
  OPEN_CONTEXT_HEALTH_EVENT,
  OPEN_SESSION_REPLAY_EVENT,
  resolveWorkbenchDeepLink,
  type WorkbenchViewId,
} from '../utils/workbenchViews';
import type { AppState, PreviewTab } from './appStore';
import { useRightPanelTabsStore } from './rightPanelTabsStore';

type WorkbenchActionName =
  | 'syncWorkbenchForSession'
  | 'openWorkbenchTab'
  | 'closeWorkbenchTab'
  | 'setActiveWorkbenchTab';

interface WorkbenchActionDependencies {
  set: StoreApi<AppState>['setState'];
  get: StoreApi<AppState>['getState'];
  nextPreviewTabTick: () => number;
}

const previewPathOf = (id: `preview:${string}`): string => id.slice('preview:'.length);

export function createWorkbenchActions({
  set,
  get,
  nextPreviewTabTick,
}: WorkbenchActionDependencies): Pick<AppState, WorkbenchActionName> {
  return {
    syncWorkbenchForSession: (sessionId) => {
      const state = get();
      const { logsPinned } = useRightPanelTabsStore.getState();
      const outgoingTabs = state.workbenchTabs.filter((view) => view !== 'logs' || logsPinned);
      const workbenchBySession = state.workbenchSessionKey
        ? {
            ...state.workbenchBySession,
            [state.workbenchSessionKey]: {
              tabs: outgoingTabs,
              active: outgoingTabs.includes(state.activeWorkbenchTab as WorkbenchViewId)
                ? state.activeWorkbenchTab
                : outgoingTabs[0] ?? null,
            },
          }
        : state.workbenchBySession;
      const restored = sessionId ? workbenchBySession[sessionId] : undefined;
      const restoredTabs = (restored?.tabs ?? []).filter((view) => (
        !isPreviewWorkbenchView(view)
        || state.previewTabs.some((tab) => view === `preview:${tab.path}`)
      ));
      const withTask = sessionId && !restoredTabs.includes('overview')
        ? ['overview' as const, ...restoredTabs]
        : restoredTabs;
      const carryPinnedLogs = logsPinned && state.workbenchTabs.includes('logs');
      const workbenchTabs = carryPinnedLogs && !withTask.includes('logs')
        ? [...withTask, 'logs' as const]
        : withTask;
      const restoredActive = restored?.active ?? null;
      const activeWorkbenchTab = carryPinnedLogs
        ? 'logs'
        : restoredActive && workbenchTabs.includes(restoredActive)
          ? restoredActive
          : workbenchTabs[0] ?? null;

      set({
        workbenchBySession,
        workbenchTabs,
        activeWorkbenchTab,
        workbenchSessionKey: sessionId,
        // 全新会话（无快照）一律回产品默认收起，同时保留常驻任务页签。
        // 若放任 collapsed 跨会话泄漏，上一会话的展开状态会直接带进新会话。
        // 有快照的回访会话不动（用户离开时的开/合就是意图）；sessionId=null（欢迎页）不动。
        // workbenchCollapsedByUser 不动：这不是用户按的，任务活动照样能把右栏带出来（#700 语义）。
        ...(sessionId && !restored ? { workbenchCollapsed: true } : {}),
      });
      useRightPanelTabsStore.getState().resetLogsTarget();
    },

    openWorkbenchTab: (id, options) => {
      noteSurfaceIntentNavigation(surfaceIntentViewForWorkbenchTab(id), options?.source ?? 'user');
      const target = resolveWorkbenchDeepLink(id);
      if (target.kind === 'capabilityHub') {
        get().openCapabilityHub(target.tab);
        return;
      }
      if (target.kind === 'contextHealth') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_HEALTH_EVENT));
        }
        return;
      }
      if (target.kind === 'sessionReplay') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(OPEN_SESSION_REPLAY_EVENT));
        }
        return;
      }
      if (target.kind === 'projectCollaboration') {
        get().openProjectCollaborationPage();
        return;
      }

      const activate = options?.activate !== false;
      // 后台自动开页只登记 tab，不夺走用户正在看的二级页或右栏视图。
      if (activate) get().closeSecondaryPages();
      const view = target.view;
      set((state) => {
        const taskWorkbenchOpenSource = id === 'task' || id === 'overview'
          ? options?.source === 'auto' && state.taskWorkbenchOpenSource === 'user'
            ? 'user'
            : options?.source ?? 'user'
          : state.taskWorkbenchOpenSource;
        // 'browser'（Agent 浏览器现场）不再借用 preview tab 状态（S2 归位）——
        // liveDev 预览与文件预览统一走 `preview:${path}` 一对一 scheme。
        const targetPreview = isPreviewWorkbenchView(view)
          ? state.previewTabs.find((tab) => tab.path === previewPathOf(view)) ?? null
          : null;
        const previewTabs = targetPreview
          ? state.previewTabs.map((tab) => (
              tab.id === targetPreview.id
                ? { ...tab, lastActivatedAt: nextPreviewTabTick() }
                : tab
            ))
          : state.previewTabs;
        return {
          ...state,
          // 打开一个视图 = 要看右栏，所以默认清掉收起位。
          // 唯一例外：活动信号（source: 'auto'）撞上**用户自己按过的收起**——那是 #700 的
          // 「收起后不因活动信号自己弹回」。产品默认的收起态（workbenchCollapsedByUser=false）
          // 不算用户意图，任务开跑照样把右栏带出来（2026-07-27 产品负责人拍板）。
          workbenchCollapsed: activate
            ? options?.source === 'auto' && state.workbenchCollapsedByUser
            : state.workbenchCollapsed,
          workbenchTabs: state.workbenchTabs.includes(view)
            ? state.workbenchTabs
            : [...state.workbenchTabs, view],
          activeWorkbenchTab: activate ? view : state.activeWorkbenchTab,
          activePreviewTabId: activate ? targetPreview?.id ?? state.activePreviewTabId : state.activePreviewTabId,
          previewTabs,
          taskWorkbenchOpenSource,
        };
      });
    },

    closeWorkbenchTab: (id) => {
      const target = resolveWorkbenchDeepLink(id);
      if (target.kind === 'capabilityHub') {
        get().setShowCapabilityHub(false);
        return;
      }
      if (target.kind === 'projectCollaboration') {
        get().closeProjectCollaborationPage();
        return;
      }
      if (target.kind !== 'workbench') return;

      const view = target.view;
      if (view === 'overview' || (view === 'logs' && useRightPanelTabsStore.getState().logsPinned)) return;
      // 'browser'（Agent 浏览器现场）不再关联 preview tab，落到下方通用分支即可
      // （S2 归位）。liveDev 与文件预览统一走 `preview:${path}`，经 closePreviewTab
      // 各自独立关闭，不再互相牵连。
      if (isPreviewWorkbenchView(view)) {
        const match = get().previewTabs.find((tab) => tab.path === previewPathOf(view));
        if (match) {
          get().closePreviewTab(match.id);
          return;
        }
      }

      set((state) => {
        const nextTabs = state.workbenchTabs.filter((tab) => tab !== view);
        let nextActive: WorkbenchViewId | null = state.activeWorkbenchTab;
        if (state.activeWorkbenchTab === view) {
          const byPath = new Map(state.previewTabs.map((tab) => [tab.path, tab]));
          const survivor = nextTabs
            .filter(isPreviewWorkbenchView)
            .map((tab) => byPath.get(previewPathOf(tab)))
            .filter((tab): tab is PreviewTab => Boolean(tab))
            .reduce<PreviewTab | null>(
              (latest, tab) => (!latest || tab.lastActivatedAt > latest.lastActivatedAt ? tab : latest),
              null,
            );
          nextActive = survivor ? `preview:${survivor.path}` : nextTabs[0] ?? null;
        }
        return {
          ...state,
          workbenchTabs: nextTabs,
          activeWorkbenchTab: nextActive,
        };
      });
    },

    setActiveWorkbenchTab: (id) => {
      if (id === null) {
        set({ activeWorkbenchTab: null });
        return;
      }
      get().openWorkbenchTab(id, { source: 'user' });
    },
  };
}
