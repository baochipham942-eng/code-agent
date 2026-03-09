import React, { useEffect, useState } from 'react';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';
import type { TestRunReport } from '@shared/ipc';

interface ReportSummary {
  filePath: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  averageScore: number;
}

export const CrossExperimentPage: React.FC = () => {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const list = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as { filePath: string; timestamp?: number }[] | undefined;
        if (list && list.length > 0) {
          const summaries: ReportSummary[] = [];
          for (const item of list.slice(0, 20)) {
            try {
              const report = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, item.filePath) as TestRunReport | null | undefined;
              if (report) {
                summaries.push({
                  filePath: item.filePath,
                  timestamp: report.startTime || item.timestamp || 0,
                  total: report.total,
                  passed: report.passed,
                  failed: report.failed,
                  passRate: report.total > 0 ? Math.round((report.passed / report.total) * 100) : 0,
                  averageScore: report.averageScore,
                });
              }
            } catch { /* skip broken reports */ }
          }
          summaries.sort((a, b) => b.timestamp - a.timestamp);
          setReports(summaries);
        }
      } catch { /* best-effort */ }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const hasEnoughData = reports.length >= 2;

  const formatDate = (ts: number) =>
    ts > 0 ? new Date(ts).toLocaleString('zh-CN', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '-';

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-medium text-zinc-200">跨实验对比</h3>

      {loading && (
        <div className="flex items-center justify-center py-12 gap-3">
          <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-zinc-500">加载实验数据...</span>
        </div>
      )}

      {!loading && !hasEnoughData && (
        <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 border border-white/[0.04] flex items-center justify-center text-2xl">
            {'\u{1F4C8}'}
          </div>
          <p className="text-sm text-zinc-300">
            {reports.length === 0 ? '暂无评测报告' : '需要至少 2 轮评测数据'}
          </p>
          <p className="text-xs text-zinc-500 max-w-sm text-center">
            运行至少 2 轮评测后，对比数据将出现在此。包括通过率趋势、稳定性指标 (pass@k / pass^k) 和回归检测。
          </p>
          {reports.length === 1 && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-2">
              <p className="text-xs text-blue-400">当前有 1 份评测报告，再运行 1 轮即可开始对比</p>
            </div>
          )}
        </div>
      )}

      {!loading && hasEnoughData && (
        <>
          {/* Experiment timeline */}
          <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 overflow-hidden">
            <div className="grid grid-cols-[1fr_80px_80px_80px_100px] gap-2 px-3 py-2 text-[10px] text-zinc-500 uppercase bg-zinc-900/30 border-b border-zinc-700/30">
              <span>时间</span>
              <span>总数</span>
              <span>通过</span>
              <span>失败</span>
              <span>通过率</span>
            </div>
            {reports.map((r, i) => {
              const prevRate = i < reports.length - 1 ? reports[i + 1].passRate : null;
              const delta = prevRate !== null ? r.passRate - prevRate : null;
              return (
                <div key={r.filePath} className="grid grid-cols-[1fr_80px_80px_80px_100px] gap-2 px-3 py-2 text-[11px] border-t border-zinc-700/10 hover:bg-zinc-800/30 transition">
                  <span className="text-zinc-400">{formatDate(r.timestamp)}</span>
                  <span className="text-zinc-300 font-mono">{r.total}</span>
                  <span className="text-emerald-400 font-mono">{r.passed}</span>
                  <span className="text-red-400 font-mono">{r.failed}</span>
                  <div className="flex items-center gap-1.5">
                    <span className={`font-mono ${
                      r.passRate >= 80 ? 'text-emerald-400' : r.passRate >= 60 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {r.passRate}%
                    </span>
                    {delta !== null && (
                      <span className={`text-[9px] ${
                        delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-zinc-500'
                      }`}>
                        {delta > 0 ? '+' : ''}{delta}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Stability Report */}
          <div className="grid grid-cols-3 gap-3">
            {(() => {
              const anyPassed = reports.some(r => r.passRate > 0);
              const allPassed = reports.every(r => r.passRate === 100);
              const saturated = reports.length >= 3 && reports.slice(0, 3).every(r => r.passRate === 100);
              return [
                {
                  label: `pass@${reports.length}`,
                  desc: `${reports.length} 轮中至少 1 轮全部通过（能力上限）`,
                  value: anyPassed ? `${Math.max(...reports.map(r => r.passRate))}%` : '0%',
                  color: anyPassed ? 'text-emerald-400' : 'text-zinc-400',
                },
                {
                  label: `pass^${reports.length}`,
                  desc: `${reports.length} 轮全部通过（生产可靠性）`,
                  value: allPassed ? '100%' : `${Math.min(...reports.map(r => r.passRate))}%`,
                  color: allPassed ? 'text-emerald-400' : 'text-amber-400',
                },
                {
                  label: '饱和检测',
                  desc: '连续 100% 三轮 → 升级难度',
                  value: saturated ? '已饱和' : reports.length < 3 ? `${reports.length}/3 轮` : '未饱和',
                  color: saturated ? 'text-emerald-400' : 'text-zinc-400',
                },
              ];
            })().map(item => (
              <div key={item.label} className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
                <div className={`text-lg font-bold ${item.color}`}>{item.value}</div>
                <div className="text-xs font-medium text-zinc-400 mt-1">{item.label}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">{item.desc}</div>
              </div>
            ))}
          </div>

          {/* Trend line chart (SVG) */}
          <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-4">
            <h4 className="text-xs font-medium text-zinc-400 mb-3">通过率趋势</h4>
            {(() => {
              const sorted = reports.slice().reverse(); // oldest first
              const chartW = 600;
              const chartH = 180;
              const padL = 40;
              const padR = 20;
              const padT = 16;
              const padB = 40;
              const plotW = chartW - padL - padR;
              const plotH = chartH - padT - padB;
              const n = sorted.length;

              if (n === 0) {
                return (
                  <div className="flex items-center justify-center py-8 text-xs text-zinc-500">
                    暂无数据可绘制趋势图
                  </div>
                );
              }

              const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
              const safeRate = (v: number) => Number.isFinite(v) ? clamp(v, 0, 100) : 0;

              const xOf = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
              const yOf = (rate: number) => padT + plotH - (safeRate(rate) / 100) * plotH;

              const points = sorted.map((r, i) => {
                const rate = safeRate(r.passRate);
                return { x: xOf(i), y: yOf(rate), rate, ts: r.timestamp };
              });
              const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
              const areaPath = linePath + ` L${points[points.length - 1].x},${padT + plotH} L${points[0].x},${padT + plotH} Z`;

              const yTicks = [0, 25, 50, 75, 100];

              return (
                <div className="overflow-x-auto">
                  <svg width={chartW} height={chartH} className="text-xs">
                    {/* Y-axis grid lines & labels */}
                    {yTicks.map(tick => (
                      <g key={tick}>
                        <line
                          x1={padL} y1={yOf(tick)} x2={chartW - padR} y2={yOf(tick)}
                          stroke="currentColor" strokeOpacity={0.08} strokeDasharray={tick === 0 ? undefined : '2,3'}
                        />
                        <text x={padL - 6} y={yOf(tick) + 3} textAnchor="end" className="fill-zinc-500" fontSize={9}>
                          {tick}%
                        </text>
                      </g>
                    ))}

                    {/* Gradient area fill */}
                    <path d={areaPath} fill="url(#trendGrad)" opacity={0.3} />
                    <defs>
                      <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                      </linearGradient>
                    </defs>

                    {/* Trend line */}
                    <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinejoin="round" />

                    {/* Data points with value labels */}
                    {points.map((p, i) => {
                      const color = p.rate >= 80 ? '#34d399' : p.rate >= 60 ? '#fbbf24' : '#f87171';
                      return (
                        <g key={i}>
                          <circle cx={p.x} cy={p.y} r={4} fill={color} stroke="#18181b" strokeWidth={2} />
                          <text x={p.x} y={p.y - 8} textAnchor="middle" className="fill-zinc-300" fontSize={9} fontWeight={600}>
                            {p.rate}%
                          </text>
                        </g>
                      );
                    })}

                    {/* X-axis date labels */}
                    {points.map((p, i) => (
                      <text key={i} x={p.x} y={chartH - 6} textAnchor="middle" className="fill-zinc-500" fontSize={8}>
                        {formatDate(p.ts)}
                      </text>
                    ))}
                  </svg>
                </div>
              );
            })()}
          </div>

          {/* Regression Detection */}
          {reports.length >= 2 && (() => {
            const latest = reports[0];
            const prev = reports[1];
            const regressed = latest.passRate < prev.passRate;
            return (
              <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-4">
                <h4 className="text-xs font-medium text-zinc-400 mb-3">回归检测</h4>
                {regressed ? (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    <p className="text-xs text-red-400">
                      通过率从 {prev.passRate}% 下降到 {latest.passRate}%，建议检查失败的 Case。
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-1">前往「失败分析」页面定位回归原因</p>
                  </div>
                ) : (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                    <p className="text-xs text-emerald-400">
                      未检测到回归。最新通过率 {latest.passRate}%{
                        latest.passRate > prev.passRate ? ` (较上轮 +${latest.passRate - prev.passRate}%)` : ''
                      }
                    </p>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
};
