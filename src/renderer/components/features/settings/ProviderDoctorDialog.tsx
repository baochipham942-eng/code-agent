// ============================================================================
// ProviderDoctorDialog - 系统诊断面板
// 数据源：provider:run_doctor → 9 category 报告
// ============================================================================

import React, { useState, useCallback } from 'react';
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
} from 'lucide-react';
import { Modal } from '../../primitives';
import { Button } from '../../primitives';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { toast } from '../../../hooks/useToast';
import { useI18n } from '../../../hooks/useI18n';

// ============================================================================
// Types — 与 src/host/diagnostics/types.ts 对齐
// ============================================================================

type DoctorCategory =
  | 'environment'
  | 'database'
  | 'config'
  | 'disk'
  | 'network'
  | 'provider_health'
  | 'mcp'
  | 'hooks'
  | 'version';

type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorItem {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  details?: string;
  suggestion?: string;
  durationMs?: number;
}

interface DoctorReport {
  timestamp: number;
  durationMs: number;
  items: DoctorItem[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

export interface ProviderDoctorDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

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

const CATEGORY_ORDER: DoctorCategory[] = [
  'environment',
  'database',
  'config',
  'disk',
  'network',
  'provider_health',
  'mcp',
  'hooks',
  'version',
];

const STATUS_STYLES: Record<DoctorStatus, { badge: string; dot: string }> = {
  pass: {
    badge: 'bg-green-500/15 text-green-400 border-green-500/30',
    dot: 'bg-green-400',
  },
  warn: {
    badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-400',
  },
  fail: {
    badge: 'bg-red-500/15 text-red-400 border-red-500/30',
    dot: 'bg-red-400',
  },
  skip: {
    badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
    dot: 'bg-zinc-400',
  },
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
  defaultExpanded: boolean;
  suggestionPrefix: string;
}> = ({ item, defaultExpanded, suggestionPrefix }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasDetails = !!(item.details || item.suggestion);
  const style = STATUS_STYLES[item.status];

  return (
    <div className="border border-zinc-700/50 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/50 transition-colors"
        onClick={() => hasDetails && setExpanded(!expanded)}
        disabled={!hasDetails}
      >
        {/* Status badge */}
        <span
          className={`shrink-0 px-2 py-0.5 text-[10px] font-bold rounded border ${style.badge}`}
        >
          {STATUS_LABELS[item.status]}
        </span>

        {/* Name + message */}
        <span className="flex-1 min-w-0">
          <span className="text-sm text-zinc-200">{item.name}</span>
          <span className="text-sm text-zinc-500 ml-2">{item.message}</span>
        </span>

        {/* Expand indicator */}
        {hasDetails && (
          <span className="shrink-0 text-zinc-500">
            {expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </span>
        )}
      </button>

      {/* Details + suggestion */}
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

export const ProviderDoctorDialog: React.FC<ProviderDoctorDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useI18n();
  const doctorText = t.settings.providerDoctor;
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runDoctor = useCallback(async () => {
    setIsRunning(true);
    setReport(null);
    try {
      const result = await ipcService.invokeDomain<DoctorReport>(
        IPC_DOMAINS.PROVIDER,
        'run_doctor',
      );
      setReport(result);
    } catch (err) {
      toast.error(`${doctorText.toast.failedPrefix}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  }, [doctorText.toast.failedPrefix]);

  const handleExport = useCallback(() => {
    if (!report) return;
    const json = JSON.stringify(report, null, 2);
    navigator.clipboard.writeText(json).then(
      () => toast.success(doctorText.toast.copied),
      () => toast.error(doctorText.toast.copyFailed),
    );
  }, [doctorText.toast.copied, doctorText.toast.copyFailed, report]);

  // Group by category, ordered by CATEGORY_ORDER
  const groupedItems: Array<[DoctorCategory, DoctorItem[]]> = (() => {
    if (!report) return [];
    const byCat = report.items.reduce<Record<string, DoctorItem[]>>((acc, item) => {
      (acc[item.category] ??= []).push(item);
      return acc;
    }, {});
    return CATEGORY_ORDER
      .filter((c) => byCat[c])
      .map((c) => [c, byCat[c]] as [DoctorCategory, DoctorItem[]]);
  })();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={doctorText.title}
      size="lg"
      headerIcon={<Stethoscope className="w-5 h-5 text-blue-400" />}
      footer={
        <div className="flex w-full items-center justify-between">
          <div>
            {report && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExport}
              >
                <ClipboardCopy className="w-4 h-4 mr-1.5" />
                {doctorText.exportLogs}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {report ? (
              <Button
                variant="secondary"
                onClick={runDoctor}
                loading={isRunning}
              >
                <RefreshCw className="w-4 h-4 mr-1.5" />
                {doctorText.rerun}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={runDoctor}
                loading={isRunning}
              >
                {doctorText.start}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* Summary bar */}
      {report && (
        <div className="flex items-center gap-4 mb-4 px-3 py-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50 flex-wrap">
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

      {/* Empty state */}
      {!report && !isRunning && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <Stethoscope className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{doctorText.empty}</p>
        </div>
      )}

      {/* Loading state */}
      {isRunning && (
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
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4 text-zinc-400" />
                  <h3 className="text-sm font-medium text-zinc-300">
                    {doctorText.categoryLabels[category]}
                  </h3>
                </div>
                <div className="space-y-1.5">
                  {items.map((item, idx) => (
                    <DoctorItemRow
                      key={`${item.name}-${idx}`}
                      item={item}
                      defaultExpanded={item.status === 'fail'}
                      suggestionPrefix={doctorText.suggestionPrefix}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};

export default ProviderDoctorDialog;
