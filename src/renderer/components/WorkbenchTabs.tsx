// ============================================================================
// WorkbenchTabs - Empty-state launcher and single-select view switcher
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FileText,
  FolderTree,
  Globe2,
  LayoutDashboard,
  Palette,
  PanelRightClose,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  formatShortcutForDisplay,
  getKeybindingAccelerator,
  type KeybindingActionId,
} from '@shared/keybindings';
import { useAppStore, type WorkbenchViewId } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from '../hooks/useI18n';
import { useKeybindingsSettings } from '../hooks/useKeybindingsSettings';
import { claimDesignCanvasForSession } from './design/designCanvasLaunch';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { IconButton } from './primitives/IconButton';

const PREVIEW_PREFIX = 'preview:';

type LaunchableWorkbenchViewId = Exclude<WorkbenchViewId, `preview:${string}`>;

interface LaunchableViewDefinition {
  id: LaunchableWorkbenchViewId;
  icon: LucideIcon;
  iconClassName: string;
  // 必填：每个视图入口都要有「打开这个视图」的 action，新增视图时漏配会在这里编译报错，
  // 而不是静默变成「别的视图有键、它没有」。
  keybindingActionId: KeybindingActionId;
}

const LAUNCHABLE_VIEWS: readonly LaunchableViewDefinition[] = [
  {
    id: 'overview',
    icon: LayoutDashboard,
    iconClassName: 'text-cyan-400/80',
    keybindingActionId: 'statusRail.toggle',
  },
  {
    id: 'files',
    icon: FolderTree,
    iconClassName: 'text-amber-400/80',
    // 不是 files.attach——那是输入框的附件选择器（scope: 'composer'），不是「打开文件视图」。
    keybindingActionId: 'files.open',
  },
  {
    id: 'browser',
    icon: Globe2,
    iconClassName: 'text-emerald-400/80',
    keybindingActionId: 'browser.open',
  },
  {
    id: 'design-canvas',
    icon: Palette,
    iconClassName: 'text-fuchsia-400/80',
    keybindingActionId: 'designCanvas.open',
  },
];

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

interface TabMeta {
  id: WorkbenchViewId;
  label: string;
  title: string;
  icon: LucideIcon;
  iconClassName: string;
  isDirty: boolean;
}

interface WorkbenchViewLauncherProps {
  openedViews: WorkbenchViewId[];
  canOpenDesignCanvas: boolean;
  mode: 'empty' | 'popover';
  onOpen: (id: LaunchableWorkbenchViewId) => void;
}

const WorkbenchViewLauncher: React.FC<WorkbenchViewLauncherProps> = ({
  openedViews,
  canOpenDesignCanvas,
  mode,
  onOpen,
}) => {
  const { t } = useI18n();
  const { keybindings, platform } = useKeybindingsSettings();
  const availableViews = LAUNCHABLE_VIEWS.filter((view) => !openedViews.includes(view.id));

  const labelFor = (id: LaunchableWorkbenchViewId): string => {
    if (id === 'overview') return t.workbenchTabs.overviewLabel;
    if (id === 'files') return t.workbenchTabs.filesLabel;
    if (id === 'browser') return t.workbenchTabs.browserLabel;
    return t.design.canvasTabLabel;
  };

  // 「设计画布」这种名字没人知道是什么，光靠标签选不出来
  const descriptionFor = (id: LaunchableWorkbenchViewId): string => {
    const d = t.workbenchTabs.viewDescriptions;
    if (id === 'overview') return d.overview;
    if (id === 'files') return d.files;
    if (id === 'browser') return d.browser;
    return d.designCanvas;
  };

  return (
    <div
      data-testid={mode === 'empty' ? 'workbench-empty-launcher' : 'workbench-view-launcher-panel'}
      className={mode === 'empty'
        ? 'flex h-full flex-1 items-center justify-center px-8 py-10'
        : 'w-full'}
    >
      <div className={mode === 'empty' ? 'w-full max-w-md' : 'w-full'}>
        <h2 className={mode === 'empty'
          ? 'mb-4 px-3 text-sm font-medium text-zinc-300'
          : 'mb-1 px-2.5 text-[11px] font-medium text-zinc-500'}
        >
          {mode === 'empty' ? t.workbenchTabs.emptyTitle : t.workbenchTabs.availableViews}
        </h2>
        <div className="space-y-1" role="list" aria-label={t.workbenchTabs.availableViews}>
          {availableViews.map((view) => {
            const Icon = view.icon;
            const accelerator = getKeybindingAccelerator(keybindings, view.keybindingActionId, platform);
            const shortcut = accelerator
              ? formatShortcutForDisplay(accelerator, platform)
              : null;
            const isDisabled = view.id === 'design-canvas' && !canOpenDesignCanvas;
            return (
              <div key={view.id} role="listitem">
                <button /* ds-allow:button: Codex 式整行视图入口，Button primitive 的居中动作布局不适配 */
                  type="button"
                  data-testid={`open-workbench-view-${view.id}`}
                  disabled={isDisabled}
                  onClick={() => onOpen(view.id)}
                  className={`flex w-full items-center gap-3 rounded-lg text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 ${
                    mode === 'empty' ? 'px-4 py-3 text-sm' : 'px-3 py-2 text-xs'
                  }`}
                >
                  <Icon className={`h-4 w-4 flex-shrink-0 ${view.iconClassName}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{labelFor(view.id)}</span>
                    <span className="block truncate text-[11px] font-normal text-zinc-500">
                      {descriptionFor(view.id)}
                    </span>
                  </span>
                  {shortcut && (
                    <kbd
                      data-testid={`workbench-shortcut-${view.id}`}
                      className="flex-shrink-0 rounded border border-zinc-700 bg-zinc-950/70 px-1.5 py-0.5 font-sans text-[11px] text-zinc-500"
                    >
                      {shortcut}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const WorkbenchTabs: React.FC = () => {
  const { t } = useI18n();
  const workbenchTabs = useAppStore((s) => s.workbenchTabs);
  const activeWorkbenchTab = useAppStore((s) => s.activeWorkbenchTab);
  const previewTabs = useAppStore((s) => s.previewTabs);
  const closeWorkbenchTab = useAppStore((s) => s.closeWorkbenchTab);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setWorkbenchCollapsed = useAppStore((s) => s.setWorkbenchCollapsed);
  // 一个弹窗管两件事：切到已打开的面板 + 添加还没打开的面板。分成两个入口时
  // 用户在「概览 ∨」里看不到别的面板，会以为切不过去。
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<TabMeta | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const metas: TabMeta[] = workbenchTabs.map((id) => {
    if (id === 'overview') {
      return {
        id,
        label: t.workbenchTabs.overviewLabel,
        title: t.workbenchTabs.overviewTitle,
        icon: LayoutDashboard,
        iconClassName: 'text-cyan-400/80',
        isDirty: false,
      };
    }
    if (id === 'files') {
      return {
        id,
        label: t.workbenchTabs.filesLabel,
        title: t.workbenchTabs.filesTitle,
        icon: FolderTree,
        iconClassName: 'text-amber-400/80',
        isDirty: false,
      };
    }
    if (id === 'browser') {
      return {
        id,
        label: t.workbenchTabs.browserLabel,
        title: t.workbenchTabs.browserTitle,
        icon: Globe2,
        iconClassName: 'text-emerald-400/80',
        isDirty: false,
      };
    }
    if (id === 'design-canvas') {
      return {
        id,
        label: t.design.canvasTabLabel,
        title: t.design.canvasTabLabel,
        icon: Palette,
        iconClassName: 'text-fuchsia-400/80',
        isDirty: false,
      };
    }
    const path = id.slice(PREVIEW_PREFIX.length);
    const previewTab = previewTabs.find((preview) => preview.path === path);
    return {
      id,
      label: getFileName(path),
      title: path,
      icon: FileText,
      iconClassName: 'text-zinc-400',
      isDirty: previewTab ? previewTab.content !== previewTab.savedContent : false,
    };
  });

  const activeMeta = metas.find((meta) => meta.id === activeWorkbenchTab) ?? metas[0] ?? null;
  const ActiveIcon = activeMeta?.icon;
  const canAddAny = LAUNCHABLE_VIEWS.some((view) => !workbenchTabs.includes(view.id));

  const openView = (id: LaunchableWorkbenchViewId) => {
    if (id === 'design-canvas') {
      if (!currentSessionId) return;
      claimDesignCanvasForSession(currentSessionId);
    }
    openWorkbenchTab(id, { source: 'user' });
    setMenuOpen(false);
  };

  const requestClose = (meta: TabMeta) => {
    if (meta.isDirty) {
      setPendingClose(meta);
      return;
    }
    closeWorkbenchTab(meta.id);
  };

  if (metas.length === 0) {
    return (
      <WorkbenchViewLauncher
        openedViews={workbenchTabs}
        canOpenDesignCanvas={Boolean(currentSessionId)}
        mode="empty"
        onOpen={openView}
      />
    );
  }

  const selectView = (id: WorkbenchViewId) => {
    openWorkbenchTab(id, { source: 'user' });
    setMenuOpen(false);
  };

  return (
    <>
      <div
        ref={toolbarRef}
        data-testid="workbench-view-selector"
        className="relative flex items-center gap-1.5 border-b border-zinc-700 bg-zinc-900 px-2 py-1.5"
      >
        <div className="relative min-w-0 flex-1">
          <button /* ds-allow:button: 单选器触发器需保留当前视图图标、脏状态与下拉箭头，Button primitive 布局不适配 */
            type="button"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-label={t.workbenchTabs.chooseView}
            title={activeMeta?.title}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-7 min-w-0 max-w-56 items-center gap-2 rounded-md px-2 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            {activeMeta && ActiveIcon && (
              <>
                <ActiveIcon className={`h-3.5 w-3.5 flex-shrink-0 ${activeMeta.iconClassName}`} />
                <span className="truncate">{activeMeta.label}</span>
                {activeMeta.isDirty && (
                  <span className="text-[10px] leading-none text-amber-400" title="未保存">●</span>
                )}
              </>
            )}
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
          </button>

          {menuOpen && (
            <div
              data-testid="workbench-view-menu"
              className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl"
            >
              <div role="listbox" aria-label={t.workbenchTabs.openViews}>
                {metas.map((meta) => {
                  const Icon = meta.icon;
                  const isActive = meta.id === activeMeta?.id;
                  return (
                    // wrapper 只做布局，role=presentation 保证 listbox 的 a11y 子项仍是 option 本身
                    <div key={meta.id} role="presentation" className="flex items-center gap-1">
                      <button /* ds-allow:button: listbox option 采用整行单选布局，Button primitive 的动作按钮形态不适配 */
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        title={meta.title}
                        onClick={() => selectView(meta.id)}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                          isActive
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                        }`}
                      >
                        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${meta.iconClassName}`} />
                        <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                        {meta.isDirty && <span className="text-[10px] leading-none text-amber-400">●</span>}
                        {isActive && <Check className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400" />}
                      </button>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        icon={<X />}
                        aria-label={t.workbenchTabs.closeView.replace('{view}', meta.label)}
                        title={t.workbenchTabs.closeView.replace('{view}', meta.label)}
                        onClick={() => {
                          setMenuOpen(false);
                          requestClose(meta);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {canAddAny && (
                <>
                  <div className="my-1 border-t border-zinc-800" />
                  <WorkbenchViewLauncher
                    openedViews={workbenchTabs}
                    canOpenDesignCanvas={Boolean(currentSessionId)}
                    mode="popover"
                    onOpen={openView}
                  />
                </>
              )}
            </div>
          )}
        </div>

        <IconButton
          size="sm"
          variant="ghost"
          icon={<PanelRightClose />}
          aria-label={t.workbenchTabs.collapsePanel}
          title={t.workbenchTabs.collapsePanel}
          onClick={() => setWorkbenchCollapsed(true)}
        />
      </div>

      <ConfirmDialog
        isOpen={pendingClose !== null}
        title="关闭未保存的文件？"
        message={pendingClose ? `${pendingClose.label} 的修改尚未保存，关闭后这些修改会丢失。` : ''}
        variant="danger"
        confirmText="关闭且不保存"
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          if (pendingClose) closeWorkbenchTab(pendingClose.id);
          setPendingClose(null);
        }}
      />
    </>
  );
};
