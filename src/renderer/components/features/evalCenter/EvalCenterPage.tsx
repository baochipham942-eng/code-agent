// ============================================================================
// EvalCenterPage - 评测中心（admin-only）
//
// 契约：
// - 整窗页统一外壳（FullScreenPage），v2 四个 tab：回放 / 验证 / 遥测 / 基准，
//   分段 tab 模式照 CapabilityHubPage；tab 状态存 appStore.evalCenterTab，页内
//   切换走 setEvalCenterTab（不动互斥表、不重置回放深链）。
// - 入口：用户菜单（admin-only，canAccessFeature('eval.center')）、会话行 hover 眼睛
//   图标（openEvalCenter('replay', sessionId) 深链）、useInAppValidationBridge（IPC
//   请求且本页未打开时 openEvalCenter('validation')）。
// - 不抢占：本页已打开时 bridge 只写 pendingInAppValidationRequest，由这里给「验证」
//   tab 上角标提示，不打断用户当前 tab。
// - v2 新增：「遥测」tab 内嵌去外壳化的会话遥测查看器（EvalTelemetryTab，复用
//   features/telemetry 子组件）；「基准」tab 为 eval-harness 跑分结果只读视图
//   （EvalBenchmarksTab，experiments 表 + aily 五关卡分组分层）。
// - 内容区契约（2026-07-27 UX 收尾 1.4）：PageContent 全 bleed 形态（scroll/padding
//   关闭），四个 tab 内容自管面板布局与内边距。
// - 门禁双保险：入口已在菜单层拦 admin；这里再校验一次，非 admin 只给提示页。
// ============================================================================
import React, { useMemo } from 'react';
import { Gauge } from 'lucide-react';
import { useAppStore, type EvalCenterTab } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { canAccessFeature, createAccessSubject } from '../../../utils/accessControl';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';

// 四个 tab 内容都偏重（回放面板 / 验证工作台 / 遥测查看器 / 基准视图），懒加载，
// 首开评测中心不背全部包。
const EvalReplayExplorer = React.lazy(() => import('./EvalReplayExplorer').then((m) => ({ default: m.EvalReplayExplorer })));
const InAppValidationWorkspace = React.lazy(() => import('../inAppValidation/InAppValidationWorkspace').then((m) => ({ default: m.InAppValidationWorkspace })));
const EvalTelemetryTab = React.lazy(() => import('./EvalTelemetryTab').then((m) => ({ default: m.EvalTelemetryTab })));
const EvalBenchmarksTab = React.lazy(() => import('./EvalBenchmarksTab').then((m) => ({ default: m.EvalBenchmarksTab })));

const EVAL_TABS: Array<{ key: EvalCenterTab; label: (t: ReturnType<typeof useI18n>['t']) => string }> = [
  { key: 'replay', label: (t) => t.evalCenter.tabReplay },
  { key: 'validation', label: (t) => t.evalCenter.tabValidation },
  { key: 'telemetry', label: (t) => t.evalCenter.tabTelemetry },
  { key: 'benchmarks', label: (t) => t.evalCenter.tabBenchmarks },
];

const EVAL_TAB_CONTENT: Record<EvalCenterTab, React.ReactNode> = {
  replay: <EvalReplayExplorer />,
  validation: <InAppValidationWorkspace />,
  telemetry: <EvalTelemetryTab />,
  benchmarks: <EvalBenchmarksTab />,
};

export const EvalCenterPage: React.FC = () => {
  const { t } = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const canAccess = canAccessFeature('eval.center', accessSubject);
  const evalCenterTab = useAppStore((s) => s.evalCenterTab);
  const setEvalCenterTab = useAppStore((s) => s.setEvalCenterTab);
  const hasPendingValidationRequest = useAppStore((s) => Boolean(s.pendingInAppValidationRequest));
  // bridge 不抢占语义的可视化：验证请求 pending 而用户停在别的 tab 时，给角标。
  const showValidationBadge = hasPendingValidationRequest && evalCenterTab !== 'validation';

  return (
    // 2026-07-27 拍板改 inline（侧栏常驻）：与其他二级页一致，返回语义交给侧栏
    <FullScreenPage testId="eval-center-page" variant="inline">
      <FullScreenPageHeader
        icon={<Gauge className="h-4 w-4 text-amber-300" />}
        title={t.evalCenter.title}
        description={t.evalCenter.description}
        actions={canAccess ? (
          <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
            {EVAL_TABS.map(({ key, label }) => (
              <button /* ds-allow:button: 评测中心 tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={evalCenterTab === key}
                data-testid={`eval-center-tab-${key}`}
                onClick={() => setEvalCenterTab(key)}
                className={`relative rounded px-2.5 py-1 text-xs transition-colors ${evalCenterTab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {label(t)}
                {key === 'validation' && showValidationBadge && (
                  <span
                    data-testid="eval-center-validation-badge"
                    className="absolute -right-1 -top-1 rounded-full border border-sky-500/40 bg-sky-500/20 px-1 text-[9px] leading-3 text-sky-200"
                  >
                    {t.evalCenter.newRequestBadge}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : undefined}
      />
      {canAccess ? (
        <PageContent scroll={false} padding={false}>
          <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">{t.settings.modal.loading}</div>}>
            {EVAL_TAB_CONTENT[evalCenterTab]}
          </React.Suspense>
        </PageContent>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          {t.evalCenter.adminOnly}
        </div>
      )}
    </FullScreenPage>
  );
};
