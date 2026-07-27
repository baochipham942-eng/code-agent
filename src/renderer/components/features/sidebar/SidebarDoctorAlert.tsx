// ============================================================================
// SidebarDoctorAlert —— 侧栏诊断问题徽标行
// 不打扰原则：仅当启动静默快检（或后续任何报告）存在 fail 项时出现，
// 全绿/warn 不渲染任何东西。点击深链打开设置并定位到「诊断」页
// （openSettingsTab('doctor')，复用 store 里的报告）。
// 视觉语言跟随能力区既有「图标右上角状态圆点」模式（见 automation running 圆点）。
// ============================================================================

import React from 'react';
import { ChevronRight, Stethoscope } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useDoctorStore, hasDoctorFailures } from '../../../stores/doctorStore';

export const SidebarDoctorAlert: React.FC = () => {
  const { t } = useI18n();
  const cz = t.sidebar.capabilityZone;
  const report = useDoctorStore((state) => state.report);

  if (!hasDoctorFailures(report)) return null;

  const label = cz.doctorIssues.replace('{count}', String(report.summary.fail));

  return (
    <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），与相邻入口行同构 */
      type="button"
      onClick={() => useAppStore.getState().openSettingsTab('doctor')}
      data-testid="sidebar-doctor-alert"
      title={cz.doctorIssuesSubtitle}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
    >
      <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center text-zinc-500">
        <Stethoscope className="h-4 w-4" />
        <span
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-400"
          data-testid="sidebar-doctor-alert-dot"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
        {label}
      </span>
      <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
    </button>
  );
};

export default SidebarDoctorAlert;
