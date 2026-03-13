import React from 'react';
import type { TestRunReport } from '@shared/ipc';

interface Props {
  report: TestRunReport;
}

export const TestResultsSummary: React.FC<Props> = ({ report }) => {
  const hasStability = report.unstableCaseCount != null;

  const cards = [
    {
      label: '通过',
      value: report.passed,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
    },
    {
      label: '失败',
      value: report.failed,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
      border: 'border-red-500/20',
    },
    {
      label: '部分通过',
      value: report.partial,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
    },
    {
      label: '总分',
      value: `${Math.round(report.averageScore * 100)}%`,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/20',
    },
    ...(hasStability ? [
      {
        label: '不稳定用例',
        value: report.unstableCaseCount!,
        color: report.unstableCaseCount! > 0 ? 'text-orange-400' : 'text-zinc-500',
        bg: report.unstableCaseCount! > 0 ? 'bg-orange-500/10' : 'bg-zinc-500/10',
        border: report.unstableCaseCount! > 0 ? 'border-orange-500/20' : 'border-zinc-500/20',
      },
      {
        label: '平均标准差',
        value: (report.averageStdDev ?? 0).toFixed(3),
        color: (report.averageStdDev ?? 0) > 0.2 ? 'text-orange-400' : 'text-zinc-400',
        bg: 'bg-zinc-500/10',
        border: 'border-zinc-500/20',
      },
    ] : []),
  ];

  return (
    <div className={`grid gap-3 ${hasStability ? 'grid-cols-6' : 'grid-cols-4'}`}>
      {cards.map((card) => (
        <div
          key={card.label}
          className={`${card.bg} border ${card.border} rounded-lg p-3 text-center`}
        >
          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
          <div className="text-[11px] text-zinc-400 mt-1">{card.label}</div>
        </div>
      ))}
    </div>
  );
};
