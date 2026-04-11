// ============================================================================
// ProviderDoctorDialog - 系统诊断面板
// ============================================================================

import React, { useState, useCallback } from 'react';
import {
  Monitor,
  Wifi,
  Settings,
  Database,
  HardDrive,
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

// ============================================================================
// Types (mirrors doctor.ipc.ts)
// ============================================================================

interface DiagnosticItem {
  category: 'environment' | 'network' | 'config' | 'database' | 'disk';
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

interface DiagnosticReport {
  timestamp: number;
  items: DiagnosticItem[];
  summary: { pass: number; warn: number; fail: number };
}

export interface ProviderDoctorDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const CATEGORY_ICONS: Record<DiagnosticItem['category'], React.FC<{ className?: string }>> = {
  environment: Monitor,
  network: Wifi,
  config: Settings,
  database: Database,
  disk: HardDrive,
};

const CATEGORY_LABELS: Record<DiagnosticItem['category'], string> = {
  environment: '运行环境',
  network: '网络连接',
  config: '配置文件',
  database: '数据库',
  disk: '磁盘存储',
};

const STATUS_STYLES: Record<DiagnosticItem['status'], { badge: string; dot: string }> = {
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
};

const STATUS_LABELS: Record<DiagnosticItem['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

// ============================================================================
// Sub-components
// ============================================================================

const DiagnosticItemRow: React.FC<{
  item: DiagnosticItem;
  defaultExpanded: boolean;
}> = ({ item, defaultExpanded }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasDetails = !!item.details;
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

      {/* Details */}
      {hasDetails && expanded && (
        <div className="px-3 pb-2.5 pt-0">
          <pre className="text-xs text-zinc-400 bg-zinc-800/60 rounded p-2 whitespace-pre-wrap break-all">
            {item.details}
          </pre>
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
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runDiagnostics = useCallback(async () => {
    setIsRunning(true);
    setReport(null);
    try {
      const result = await ipcService.invokeDomain<DiagnosticReport>(
        IPC_DOMAINS.PROVIDER,
        'run_diagnostics',
      );
      setReport(result);
    } catch (err) {
      toast.error(`诊断失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleExport = useCallback(() => {
    if (!report) return;
    const json = JSON.stringify(report, null, 2);
    navigator.clipboard.writeText(json).then(
      () => toast.success('诊断报告已复制到剪贴板'),
      () => toast.error('复制失败'),
    );
  }, [report]);

  // Group items by category
  const groupedItems = report
    ? (Object.entries(
        report.items.reduce<Record<string, DiagnosticItem[]>>((acc, item) => {
          (acc[item.category] ??= []).push(item);
          return acc;
        }, {}),
      ) as [DiagnosticItem['category'], DiagnosticItem[]][])
    : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="系统诊断"
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
                导出日志
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {report ? (
              <Button
                variant="secondary"
                onClick={runDiagnostics}
                loading={isRunning}
              >
                <RefreshCw className="w-4 h-4 mr-1.5" />
                重新诊断
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={runDiagnostics}
                loading={isRunning}
              >
                开始诊断
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* Summary bar */}
      {report && (
        <div className="flex items-center gap-4 mb-4 px-3 py-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            {report.summary.pass} 通过
          </span>
          <span className="flex items-center gap-1.5 text-sm text-amber-400">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            {report.summary.warn} 警告
          </span>
          <span className="flex items-center gap-1.5 text-sm text-red-400">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            {report.summary.fail} 失败
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            {new Date(report.timestamp).toLocaleTimeString()}
          </span>
        </div>
      )}

      {/* Empty state */}
      {!report && !isRunning && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <Stethoscope className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">点击下方按钮开始系统诊断</p>
        </div>
      )}

      {/* Loading state */}
      {isRunning && (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-400">
          <RefreshCw className="w-8 h-8 mb-3 animate-spin opacity-50" />
          <p className="text-sm">正在运行诊断...</p>
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
                    {CATEGORY_LABELS[category]}
                  </h3>
                </div>
                <div className="space-y-1.5">
                  {items.map((item, idx) => (
                    <DiagnosticItemRow
                      key={`${item.name}-${idx}`}
                      item={item}
                      defaultExpanded={item.status === 'fail'}
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
