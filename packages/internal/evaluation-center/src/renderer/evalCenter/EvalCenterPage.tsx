// ============================================================================
// EvalCenterPage - 评测中心（admin-only）
//
// 契约：
// - 整窗页统一外壳（FullScreenPage），五个 tab：遥测 / 回放 / 题库 / 跑分 / 验证，
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
//   关闭），各 tab 内容自管面板布局与内边距。
// - 门禁双保险：入口已在菜单层拦 admin；这里再校验一次，非 admin 只给提示页。
// ============================================================================
import React, { useMemo } from 'react';
import { Gauge } from 'lucide-react';
import { useAppStore } from '@renderer/stores/appStore';
import { useEvalCenterStore, type EvalCenterTab } from '../stores/evalCenterStore';
import { useAuthStore } from '@renderer/stores/authStore';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { canAccessFeature, createAccessSubject } from '@renderer/utils/accessControl';
import { FullScreenPage, FullScreenPageHeader } from '@renderer/components/features/shared/FullScreenPage';
import { PageContent } from '@renderer/components/features/shared/PageContent';

// tab 内容都偏重（回放面板 / 题库 / 验证工作台 / 遥测查看器 / 基准视图），懒加载，
// 首开评测中心不背全部包。
const EvalReplayExplorer = React.lazy(() => import('./EvalReplayExplorer').then((m) => ({ default: m.EvalReplayExplorer })));
const InAppValidationWorkspace = React.lazy(() => import('@renderer/components/features/inAppValidation/InAppValidationWorkspace').then((m) => ({ default: m.InAppValidationWorkspace })));
const EvalTelemetryTab = React.lazy(() => import('./EvalTelemetryTab').then((m) => ({ default: m.EvalTelemetryTab })));
const EvalCaseListTab = React.lazy(() => import('./EvalCaseListTab').then((m) => ({ default: m.EvalCaseListTab })));
const EvalBenchmarksTab = React.lazy(() => import('./EvalBenchmarksTab').then((m) => ({ default: m.EvalBenchmarksTab })));
const EvalScorersTab = React.lazy(() => import('./EvalScorersTab').then((m) => ({ default: m.EvalScorersTab })));
const EvalExperimentsTab = React.lazy(() => import('./EvalExperimentsTab').then((m) => ({ default: m.EvalExperimentsTab })));

const EVAL_TABS: Array<{ key: EvalCenterTab; label: (t: ReturnType<typeof useEvaluationI18n>['t']) => string }> = [
  { key: 'telemetry', label: (t) => t.evalCenter.tabTelemetry },
  { key: 'replay', label: (t) => t.evalCenter.tabReplay },
  // 2026-08-29 爸拍板 R4：题库位于回放之后、跑分之前。
  { key: 'cases', label: (t) => t.evalCenter.tabCases },
  { key: 'scorers', label: (t) => t.evalCenter.tabScorers },
  { key: 'experiments', label: (t) => t.evalCenter.tabExperiments },
  { key: 'benchmarks', label: (t) => t.evalCenter.tabBenchmarks },
  { key: 'validation', label: (t) => t.evalCenter.tabValidation },
];

const EVAL_TAB_CONTENT: Record<EvalCenterTab, React.ReactNode> = {
  replay: <EvalReplayExplorer />,
  validation: <InAppValidationWorkspace />,
  telemetry: <EvalTelemetryTab />,
  cases: <EvalCaseListTab />,
  scorers: <EvalScorersTab />,
  experiments: <EvalExperimentsTab />,
  benchmarks: <EvalBenchmarksTab />,
};

export const EvalCenterPage: React.FC = () => {
  const { t } = useEvaluationI18n();
  const currentUser = useAuthStore((s) => s.user);
  const language = useAppStore((s) => s.language);
  const pageLabels = language === 'zh'
    ? { title: '评测中心', description: '遥测 · 会话回放 · 题库 · 跑分 · 应用内验证', adminOnly: '评测中心需要管理员权限' }
    : { title: 'Eval Center', description: 'Telemetry · Session replay · Case bank · Benchmark runs · In-app validation', adminOnly: 'The eval center requires administrator access' };
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const canAccess = canAccessFeature('capability.internal', accessSubject);
  const evalCenterTab = useEvalCenterStore((s) => s.tab);
  const setEvalCenterTab = useEvalCenterStore((s) => s.setTab);
  const hasPendingValidationRequest = useAppStore((s) => Boolean(s.pendingInAppValidationRequest));
  // bridge 不抢占语义的可视化：验证请求 pending 而用户停在别的 tab 时，给角标。
  const showValidationBadge = hasPendingValidationRequest && evalCenterTab !== 'validation';

  if (!canAccess) {
    return (
      <FullScreenPage testId="eval-center-page" variant="inline">
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          {pageLabels.adminOnly}
        </div>
      </FullScreenPage>
    );
  }

  return (
    // 2026-07-27 拍板改 inline（侧栏常驻）：与其他二级页一致，返回语义交给侧栏
    <FullScreenPage testId="eval-center-page" variant="inline">
      <FullScreenPageHeader
        icon={<Gauge className="h-4 w-4 text-badge-warning" />}
        title={pageLabels.title}
        description={pageLabels.description}
        actions={(
          <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
            {EVAL_TABS.map(({ key, label }) => (
              <button /* ds-allow:button: 评测中心 tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={evalCenterTab === key}
                data-testid={`eval-center-tab-${key}`}
                onClick={() => setEvalCenterTab(key)}
                className={`relative rounded border-b-2 px-2.5 py-1 text-xs transition-colors ${evalCenterTab === key ? 'border-brand text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
              >
                {label(t)}
                {key === 'validation' && showValidationBadge && (
                  <span
                    data-testid="eval-center-validation-badge"
                    className="absolute -right-1 -top-1 rounded-full border border-badge-info/40 bg-sky-500/20 px-1 text-[9px] leading-3 text-badge-info"
                  >
                    {t.evalCenter.newRequestBadge}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      />
      <PageContent scroll={false} padding={false}>
        <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">{t.settings.modal.loading}</div>}>
          {EVAL_TAB_CONTENT[evalCenterTab]}
        </React.Suspense>
      </PageContent>
    </FullScreenPage>
  );
};
