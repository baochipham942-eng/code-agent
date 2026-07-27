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

type WorkbenchActionName =
  | 'syncWorkbenchForSession'
  | 'openWorkbenchTab'
  | 'closeWorkbenchTab'
  | 'setActiveWorkbenchTab';

interface WorkbenchActionDependencies {
  set: StoreApi<AppState>['setState'];
  get: StoreApi<AppState>['getState'];
  nextPreviewTabTick: () => number;
  stopDevServer: (sessionId?: string) => void;
}

const previewPathOf = (id: `preview:${string}`): string => id.slice('preview:'.length);

export function createWorkbenchActions({
  set,
  get,
  nextPreviewTabTick,
  stopDevServer,
}: WorkbenchActionDependencies): Pick<AppState, WorkbenchActionName> {
  return {
    syncWorkbenchForSession: (sessionId) => {
      const state = get();
      const workbenchBySession = state.workbenchSessionKey
        ? {
            ...state.workbenchBySession,
            [state.workbenchSessionKey]: {
              tabs: [...state.workbenchTabs],
              active: state.activeWorkbenchTab,
            },
          }
        : state.workbenchBySession;
      const restored = sessionId ? workbenchBySession[sessionId] : undefined;
      const workbenchTabs = (restored?.tabs ?? []).filter((view) => (
        !isPreviewWorkbenchView(view)
        || state.previewTabs.some((tab) => tab.kind !== 'liveDev' && view === `preview:${tab.path}`)
      ));
      const restoredActive = restored?.active ?? null;
      const activeWorkbenchTab = restoredActive && !workbenchTabs.includes(restoredActive)
        ? workbenchTabs[0] ?? null
        : restoredActive;

      set({
        workbenchBySession,
        workbenchTabs,
        activeWorkbenchTab,
        workbenchSessionKey: sessionId,
      });
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

      // 打开右栏视图 = 人在会话区，二级页让位（侧栏常驻后二级页与会话区可同屏共存）。
      get().closeSecondaryPages();
      const view = target.view;
      set((state) => {
        const taskWorkbenchOpenSource = id === 'task' || id === 'overview'
          ? options?.source === 'auto' && state.taskWorkbenchOpenSource === 'user'
            ? 'user'
            : options?.source ?? 'user'
          : state.taskWorkbenchOpenSource;
        const targetPreview = view === 'browser'
          ? state.previewTabs
              .filter((tab) => tab.kind === 'liveDev')
              .reduce<PreviewTab | null>(
                (latest, tab) => (!latest || tab.lastActivatedAt > latest.lastActivatedAt ? tab : latest),
                null,
              )
          : isPreviewWorkbenchView(view)
            ? state.previewTabs.find((tab) => tab.kind !== 'liveDev' && tab.path === previewPathOf(view)) ?? null
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
          workbenchCollapsed: options?.source === 'auto' && state.workbenchCollapsedByUser,
          workbenchTabs: state.workbenchTabs.includes(view)
            ? state.workbenchTabs
            : [...state.workbenchTabs, view],
          activeWorkbenchTab: view,
          activePreviewTabId: targetPreview?.id ?? state.activePreviewTabId,
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
      if (view === 'browser') {
        get().previewTabs
          .filter((tab) => tab.kind === 'liveDev')
          .forEach((tab) => stopDevServer(tab.devServerSessionId));
        set((state) => {
          const nextTabs = state.previewTabs.filter((tab) => tab.kind !== 'liveDev');
          const nextWorkbench = state.workbenchTabs.filter((item) => item !== 'browser');
          const nextPreview = nextTabs.reduce<PreviewTab | null>(
            (latest, tab) => (!latest || tab.lastActivatedAt > latest.lastActivatedAt ? tab : latest),
            null,
          );
          return {
            ...state,
            previewTabs: nextTabs,
            activePreviewTabId: state.previewTabs.find((tab) => tab.id === state.activePreviewTabId)?.kind === 'liveDev'
              ? nextPreview?.id ?? null
              : state.activePreviewTabId,
            workbenchTabs: nextWorkbench,
            activeWorkbenchTab: state.activeWorkbenchTab === 'browser'
              ? nextWorkbench[0] ?? null
              : state.activeWorkbenchTab,
          };
        });
        return;
      }

      if (isPreviewWorkbenchView(view)) {
        const match = get().previewTabs.find((tab) => (
          tab.kind !== 'liveDev' && tab.path === previewPathOf(view)
        ));
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
          ...(view === 'overview' ? { taskWorkbenchOpenSource: null } : {}),
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
