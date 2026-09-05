// ============================================================================
// 上线后质量卡（ADR-063 刀 1 · N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// 跨会话，挂在遥测 tab 的会话列表上方。数据只有一条来路：telemetry_turn_scores
// 经 telemetry:get-postlaunch-report 出来的那份报告——卡片自己不算任何比率，
// 分母口径与本地表永远一致。
// 信号轮 / 抽样轮两行不合并：信号轮是被判有问题才评的，合并会把分布拉花。
// ============================================================================
import React from 'react';
import { AlertTriangle, Play, Loader2 } from 'lucide-react';
import type { PostLaunchDimension, PostLaunchReport, PostLaunchScopeRow } from '@shared/contract/postLaunchScore';
import { POST_LAUNCH_DIMENSIONS } from '@shared/contract/postLaunchScore';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';

interface PostLaunchCardProps {
  report: PostLaunchReport | null;
  running: boolean;
  error: string | null;
  days: number;
  onRun: () => void;
  onOpenSession: (sessionId: string) => void;
}

function formatUsd(value: number): string {
  return value.toFixed(4);
}

function ratio(row: PostLaunchScopeRow, dimension: PostLaunchDimension, noVerdict: string): string {
  const rate = row.dims[dimension];
  if (rate.judged === 0) return noVerdict;
  return `${Math.round((rate.passed / rate.judged) * 100)}%`;
}

export const PostLaunchCard: React.FC<PostLaunchCardProps> = ({
  report, running, error, days, onRun, onOpenSession,
}) => {
  const { t } = useEvaluationI18n();
  const p = t.telemetry.postLaunch;
  // IPC 回来的东西在信任边界之外：形状不对就当没有报告、渲染空态。
  // 一张卡片把整个遥测页崩掉，比它什么都不显示糟得多。
  const safe = report && Array.isArray(report.groups) && report.calibration && report.budget ? report : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-800/40 p-3" data-testid="postlaunch-card">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-zinc-300">{p.title}</h3>
          <p className="text-[10px] text-zinc-500">{p.subtitle}</p>
        </div>
        <button /* ds-allow:button: 遥测卡内 10px 微尺寸行内动作，与同页实时开关胶囊同款，Button primitive 无对应变体 */
          type="button"
          onClick={onRun}
          disabled={running}
          data-testid="postlaunch-run"
          className="flex shrink-0 items-center gap-1 rounded bg-zinc-700 px-2 py-1 text-[10px] text-zinc-300 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {running ? p.running : p.run.replace('{n}', String(days))}
        </button>
      </div>

      {safe?.calibration.state === 'insufficient' && (
        <div
          className="mb-2 flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[10px] text-badge-warning"
          data-testid="postlaunch-calibration"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{p.calibrationInsufficient}</span>
        </div>
      )}

      {typeof safe?.judgeUnavailableTurns === 'number' && safe.judgeUnavailableTurns > 0 && (
        <div
          className="mb-2 flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[10px] text-badge-warning"
          data-testid="postlaunch-judge-unavailable"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{p.judgeUnavailable.replace('{n}', String(safe.judgeUnavailableTurns))}</span>
        </div>
      )}

      {safe?.budget.stopped && (
        <div className="mb-2 rounded bg-zinc-700/40 px-2 py-1.5 text-[10px] text-zinc-400" data-testid="postlaunch-budget-stopped">
          {p.budgetStopped}
        </div>
      )}

      {error && (
        <div className="mb-2 rounded bg-red-500/10 px-2 py-1.5 text-[10px] text-badge-error" data-testid="postlaunch-error">
          {p.failed.replace('{message}', error)}
        </div>
      )}

      {safe && (
        <p className="mb-2 text-[10px] text-zinc-500" data-testid="postlaunch-budget">
          {p.budget
            .replace('{spent}', formatUsd(safe.budget.spentUsd))
            .replace('{limit}', formatUsd(safe.budget.limitUsd))
            .replace('{sampled}', String(safe.budget.sampledCount))
            .replace('{sampleLimit}', String(safe.budget.sampleLimit))}
          {safe.budget.assumedUsd > 0 && (
            <span className="ml-1 text-zinc-600" data-testid="postlaunch-budget-assumed">
              {p.budgetAssumed.replace('{assumed}', formatUsd(safe.budget.assumedUsd))}
            </span>
          )}
        </p>
      )}

      {(!safe || safe.groups.length === 0) && (
        <div className="py-6 text-center text-[11px] text-zinc-500" data-testid="postlaunch-empty">{p.empty}</div>
      )}

      {safe?.groups.map((group) => (
        <div key={`${group.weekStart}-${group.appVersion}-${group.promptVersion ?? ''}`} className="mb-2 last:mb-0">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-zinc-400">
            <span className="font-medium">{group.weekStart}</span>
            <span>{group.appVersion}</span>
            {group.promptVersion && <span className="text-zinc-500">{group.promptVersion}</span>}
            <span className="ml-auto text-zinc-500">{p.cost} ${formatUsd(group.costUsd)}</span>
          </div>

          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-0.5 text-left font-normal" />
                {POST_LAUNCH_DIMENSIONS.map((dimension) => (
                  <th key={dimension} className="py-0.5 text-right font-normal">{p.dims[dimension]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.scope} className="text-zinc-300" data-testid={`postlaunch-row-${row.scope}`}>
                  <td className="py-0.5 text-left text-zinc-400">
                    {row.scope === 'signal' ? p.scopeSignal : p.scopeSample}
                    <span className="ml-1 text-zinc-500">{p.turns.replace('{n}', String(row.turns))}</span>
                  </td>
                  {POST_LAUNCH_DIMENSIONS.map((dimension) => (
                    <td key={dimension} className="py-0.5 text-right" data-testid={`postlaunch-${row.scope}-${dimension}`}>
                      {ratio(row, dimension, p.noVerdict)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-0.5 text-[10px] text-zinc-600">{p.scopeHint}</p>

          {group.failureClasses.length > 0 && (
            <p className="mt-1 text-[10px] text-zinc-500" data-testid="postlaunch-failure-classes">
              {p.failureClasses}：{group.failureClasses.map((entry) => `${entry.code} ${entry.count}`).join(' · ')}
            </p>
          )}
          {group.signals.length > 0 && (
            <p className="text-[10px] text-zinc-500" data-testid="postlaunch-signals">
              {p.signals}：{group.signals.map((entry) => `${entry.kind} ${entry.count}`).join(' · ')}
            </p>
          )}

          <div className="mt-1 flex flex-wrap gap-1">
            {group.sessionIds.map((sessionId) => (
              <button /* ds-allow:button: 下钻芯片，10px 微尺寸，Button primitive 无 chip 变体 */
                key={sessionId}
                type="button"
                onClick={() => onOpenSession(sessionId)}
                title={p.openSession}
                data-testid={`postlaunch-session-${sessionId}`}
                className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
              >
                {sessionId.slice(0, 8)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
