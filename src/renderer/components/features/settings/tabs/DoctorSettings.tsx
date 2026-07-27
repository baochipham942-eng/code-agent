// ============================================================================
// DoctorSettings - 全量诊断设置页（9 类检查，独立菜单项）
// 由 DoctorReportDialog 弹层改造而来（工单③b 返工：全量诊断是系统级能力，
// 在设置左侧导航有独立「诊断」入口，不再混在通用模型页 / 弹层里）。
// 交互/视觉语言跟随 ProviderDoctorDialog；数据走 doctorStore：
// 启动静默快检的结果进页面时直接复用；无报告则进页自动跑一次全量。
// 支持整体重跑与单类重检，fail/warn 项带修复按钮
// （fix code → 动作映射见 utils/doctorFixActions.ts）。
// ============================================================================

import React, { useEffect, useState } from 'react';
import {
  Monitor,
  Wifi,
  Settings,
  Database,
  HardDrive,
  Server,
  Activity,
  GitBranch,
  Package,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  RefreshCw,
  Stethoscope,
  Wrench,
} from 'lucide-react';
import { Button } from '../../../primitives';
import { SettingsPage } from '../SettingsLayout';
import type { DoctorFixCode } from '@shared/constants/doctor';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { useDoctorStore } from '../../../../stores/doctorStore';
import {
  DOCTOR_CATEGORY_ORDER,
  type DoctorCategory,
  type DoctorItem,
  type DoctorStatus,
} from '../../../../types/doctor';
import { runDoctorFix } from '../../../../utils/doctorFixActions';

// ============================================================================
// Constants
// ============================================================================

const CATEGORY_ICONS: Record<DoctorCategory, React.FC<{ className?: string }>> = {
  environment: Monitor,
  network: Wifi,
  config: Settings,
  database: Database,
  disk: HardDrive,
  provider_health: Activity,
  mcp: Server,
  hooks: GitBranch,
  version: Package,
};

const STATUS_STYLES: Record<DoctorStatus, { badge: string }> = {
  pass: { badge: 'bg-green-500/15 text-green-400 border-green-500/30' },
  warn: { badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  fail: { badge: 'bg-red-500/15 text-red-400 border-red-500/30' },
  skip: { badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
};

const STATUS_LABELS: Record<DoctorStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

// ============================================================================
// Sub-components
// ============================================================================

const DoctorItemRow: React.FC<{
  item: DoctorItem;
  suggestionPrefix: string;
  fixLabel?: string;
  isFixing: boolean;
  onFix: (code: DoctorFixCode) => void;
}> = ({ item, suggestionPrefix, fixLabel, isFixing, onFix }) => {
  const [expanded, setExpanded] = useState(item.status === 'fail');
  const hasDetails = !!(item.details || item.suggestion);
  const showFix = !!item.fix && (item.status === 'fail' || item.status === 'warn');

  return (
    <div className="border border-zinc-700/50 rounded-lg overflow-hidden">
      <div className="flex items-center">
        <button
          className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/50 transition-colors"
          onClick={() => hasDetails && setExpanded(!expanded)}
          disabled={!hasDetails}
        >
          <span
            className={`shrink-0 px-2 py-0.5 text-[10px] font-bold rounded border ${STATUS_STYLES[item.status].badge}`}
          >
            {STATUS_LABELS[item.status]}
          </span>
          <span className="flex-1 min-w-0">
            <span className="text-sm text-zinc-200">{item.name}</span>
            <span className="text-sm text-zinc-500 ml-2">{item.message}</span>
          </span>
          {hasDetails && (
            <span className="shrink-0 text-zinc-500">
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </span>
          )}
        </button>
        {showFix && item.fix && (
          <span className="shrink-0 pr-2">
            <Button
              variant="secondary"
              size="sm"
              loading={isFixing}
              onClick={() => onFix(item.fix!.code)}
              data-testid={`doctor-fix-${item.fix.code}`}
            >
              <Wrench className="w-3.5 h-3.5 mr-1" />
              {fixLabel ?? item.fix.code}
            </Button>
          </span>
        )}
      </div>

      {hasDetails && expanded && (
        <div className="px-3 pb-2.5 pt-0 space-y-1.5">
          {item.suggestion && (
            <div className="text-xs text-amber-300/90 bg-amber-900/15 border border-amber-700/30 rounded p-2">
              {suggestionPrefix}{item.suggestion}
            </div>
          )}
          {item.details && (
            <pre className="text-xs text-zinc-400 bg-zinc-800/60 rounded p-2 whitespace-pre-wrap break-all">
              {item.details}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const DoctorSettings: React.FC = () => {
  const { t } = useI18n();
  const doctorText = t.settings.providerDoctor;
  const {
    report,
    isRunning,
    runningCategory,
    lastError,
    runFull,
    runCategory,
  } = useDoctorStore();
  const [fixingCode, setFixingCode] = useState<DoctorFixCode | null>(null);

  // 进页面时复用已有报告（如启动静默快检的结果）；没有则自动跑全量
  useEffect(() => {
    const state = useDoctorStore.getState();
    if (!state.report && !state.isRunning) {
      void state.runFull();
    }
  }, []);

  const handleFix = async (code: DoctorFixCode) => {
    setFixingCode(code);
    try {
      // 设置深链类 fix 会把页面切到对应设置 tab，无需额外处理
      await runDoctorFix(code);
    } catch (err) {
      toast.error(`${doctorText.fixFailedPrefix}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFixingCode(null);
    }
  };

  const handleExport = () => {
    if (!report) return;
    const json = JSON.stringify(report, null, 2);
    navigator.clipboard.writeText(json).then(
      () => toast.success(doctorText.toast.copied),
      () => toast.error(doctorText.toast.copyFailed),
    );
  };

  const groupedItems: Array<[DoctorCategory, DoctorItem[]]> = (() => {
    if (!report) return [];
    const byCat = report.items.reduce<Record<string, DoctorItem[]>>((acc, item) => {
      (acc[item.category] ??= []).push(item);
      return acc;
    }, {});
    return DOCTOR_CATEGORY_ORDER
      .filter((c) => byCat[c])
      .map((c) => [c, byCat[c]] as [DoctorCategory, DoctorItem[]]);
  })();

  return (
    <SettingsPage
      title={doctorText.title}
      description={doctorText.pageDescription}
      actions={
        <div className="flex items-center gap-2">
          {report && (
            <Button variant="ghost" size="sm" onClick={handleExport}>
              <ClipboardCopy className="w-4 h-4 mr-1.5" />
              {doctorText.exportLogs}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void runFull()}
            loading={isRunning && runningCategory === null}
            disabled={isRunning}
          >
            <RefreshCw className="w-4 h-4 mr-1.5" />
            {report ? doctorText.rerun : doctorText.start}
          </Button>
        </div>
      }
    >

      {/* Summary bar */}
      {report && (
        <div className="flex items-center gap-4 px-3 py-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50 flex-wrap">
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            {report.summary.pass}{doctorText.summary.passSuffix}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-amber-400">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            {report.summary.warn}{doctorText.summary.warnSuffix}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-red-400">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            {report.summary.fail}{doctorText.summary.failSuffix}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-zinc-400">
            <span className="inline-block w-2 h-2 rounded-full bg-zinc-400" />
            {report.summary.skip}{doctorText.summary.skipSuffix}
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            {(report.durationMs / 1000).toFixed(1)}s · {new Date(report.timestamp).toLocaleTimeString()}
          </span>
        </div>
      )}

      {/* Error state（运行失败且无报告可看时） */}
      {!report && !isRunning && lastError && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <Stethoscope className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm text-red-400">{doctorText.toast.failedPrefix}{lastError}</p>
        </div>
      )}

      {/* Empty state */}
      {!report && !isRunning && !lastError && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <Stethoscope className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{doctorText.empty}</p>
        </div>
      )}

      {/* Loading state（无报告时的整页 loading；有报告时保留旧报告，仅按钮转圈） */}
      {!report && isRunning && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-400">
          <RefreshCw className="w-8 h-8 mb-3 animate-spin opacity-50" />
          <p className="text-sm">{doctorText.running}</p>
        </div>
      )}

      {/* Results grouped by category */}
      {report && (
        <div className="space-y-5">
          {groupedItems.map(([category, items]) => {
            const Icon = CATEGORY_ICONS[category];
            const isCategoryRunning = isRunning && runningCategory === category;
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4 text-zinc-400" />
                  <h3 className="text-sm font-medium text-zinc-300">
                    {doctorText.categoryLabels[category]}
                  </h3>
                  <button
                    type="button"
                    className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                    title={doctorText.recheckCategory}
                    aria-label={doctorText.recheckCategory}
                    data-testid={`doctor-recheck-${category}`}
                    disabled={isRunning}
                    onClick={() => void runCategory(category)}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isCategoryRunning ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <div className="space-y-1.5">
                  {items.map((item, idx) => (
                    <DoctorItemRow
                      key={`${item.name}-${idx}`}
                      item={item}
                      suggestionPrefix={doctorText.suggestionPrefix}
                      fixLabel={item.fix ? doctorText.fixLabels[item.fix.code] : undefined}
                      isFixing={fixingCode !== null && fixingCode === item.fix?.code}
                      onFix={(code) => void handleFix(code)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsPage>
  );
};

export default DoctorSettings;
