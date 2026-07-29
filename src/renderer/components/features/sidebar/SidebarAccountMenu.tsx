// ============================================================================
// SidebarAccountMenu - 侧栏底部账号下拉菜单
// ============================================================================
// 从 Sidebar.tsx 抽出来（2026-07-27）：Sidebar 逼近 god-file 门（有效行 >1000），
// 加一条菜单项就顶破，`architectureDebtReport` 门在 CI 报红。按房规是收敛代码不加白名单，
// 这一整块（常用项 + 高级工具折叠组 + 设置/退出）本来就是独立语义单元，直接成组件。
//
// 状态一律自取（useAppStore / useAuthStore），只从宿主接四个它自己不该知道的：
// 关闭回调、高级工具折叠态与它的开关、以及当前会话所属项目 id。
// ============================================================================

import React from 'react';
import {
  Activity,
  CalendarDays,
  ChevronRight,
  FlaskConical,
  Gauge,
  LogOut,
  Monitor,
  MonitorSmartphone,
  ScrollText,
  Settings,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { canAccessFeature } from '../../../utils/accessControl';
import { AccountMenuItem, AccountMenuLabel } from './sidebarPresentation';

interface SidebarAccountMenuProps {
  onClose: () => void;
  advancedToolsOpen: boolean;
  onToggleAdvancedTools: () => void;
  hasActiveAdvancedTool: boolean;
}

export const SidebarAccountMenu: React.FC<SidebarAccountMenuProps> = ({
  onClose,
  advancedToolsOpen,
  onToggleAdvancedTools,
  hasActiveAdvancedTool,
}) => {
  const { t } = useI18n();
  const sb = t.sidebar;
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const {
    setShowSettings,
    showLab,
    setShowLab,
    showTimeCapabilityCenter,
    setShowTimeCapabilityCenter,
    showDesktopPanel,
    setShowDesktopPanel,
    showActivityPanel,
    setShowActivityPanel,
    showLocalOpsPanel,
    openLocalOpsPanel,
    showEvalCenter,
    openEvalCenter,
    setShowPromptManager,
  } = useAppStore();

  // 评测中心与提示词管理同为 admin-only：门禁走 user.isAdmin 的 verified claim，
  // 与账号行上的「管理员」徽标同一条通路。
  const canOpenEvalCenter = canAccessFeature('eval.center', user);
  const canOpenPromptManager = canAccessFeature('prompt.manager', user);

  return (
    <div className="absolute bottom-full left-2 right-2 z-50 max-h-[80vh] overflow-y-auto rounded-xl elevation-l2 popover-enter py-1">
      <AccountMenuLabel>{sb.menuCommon}</AccountMenuLabel>
      <AccountMenuItem
        onClick={() => { setShowActivityPanel(true); onClose(); }}
        icon={<Activity className={`w-4 h-4 ${showActivityPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
        label={sb.menuActivity}
      />
      <AccountMenuItem
        onClick={() => { openLocalOpsPanel('desktop'); onClose(); }}
        icon={<MonitorSmartphone className={`w-4 h-4 ${showLocalOpsPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
        label={sb.menuLocalOps}
      />
      {/* 「协作请求（@neo）」入口已拿掉（爸 2026-07-29）：topic 目录的家=协作空间页任务 tab */}
      {canOpenEvalCenter && (
        <AccountMenuItem
          onClick={() => { openEvalCenter(); onClose(); }}
          icon={<Gauge className={`w-4 h-4 ${showEvalCenter ? 'text-amber-400' : 'text-amber-400/80'}`} />}
          label={sb.menuEvalCenter}
        />
      )}
      {canOpenPromptManager && (
        <AccountMenuItem
          onClick={() => { setShowPromptManager(true); onClose(); }}
          icon={<ScrollText className="w-4 h-4 text-violet-400/80" />}
          label={sb.menuPromptManager}
          testId="user-menu-open-prompt-manager"
        />
      )}

      <div className="my-1 border-t border-zinc-800" />
      <button /* ds-allow:button: 折叠组头是 11px 微字号纯文本行头，primitive 无对应变体（同款豁免见 SidebarProjectDrawer） */
        type="button"
        onClick={onToggleAdvancedTools}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${advancedToolsOpen ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 text-left">{sb.advancedTools}</span>
        {hasActiveAdvancedTool && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            {sb.advancedToolsRunning}
          </span>
        )}
      </button>
      {advancedToolsOpen && (
        <div className="pb-1">
          <AccountMenuItem
            onClick={() => { setShowLab(true); onClose(); }}
            icon={<FlaskConical className={`w-4 h-4 ${showLab ? 'text-emerald-400' : 'text-emerald-400/80'}`} />}
            label={sb.menuModelTraining}
          />
          <AccountMenuItem
            onClick={() => { setShowTimeCapabilityCenter(!showTimeCapabilityCenter); onClose(); }}
            icon={<CalendarDays className={`w-4 h-4 ${showTimeCapabilityCenter ? 'text-sky-400' : 'text-sky-400/80'}`} />}
            label={sb.menuTimeCapability}
          />
          <AccountMenuItem
            onClick={() => { setShowDesktopPanel(!showDesktopPanel); onClose(); }}
            icon={<Monitor className={`w-4 h-4 ${showDesktopPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
            label={sb.menuDesktopCapture}
          />
        </div>
      )}

      <div className="border-t border-zinc-800" />
      <AccountMenuItem
        onClick={() => { setShowSettings(true); onClose(); }}
        icon={<Settings className="w-4 h-4" />}
        label={sb.menuSettings}
      />
      <AccountMenuItem
        onClick={() => { signOut(); onClose(); }}
        icon={<LogOut className="w-4 h-4" />}
        label={sb.menuSignOut}
      />
    </div>
  );
};
