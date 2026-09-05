// ============================================================================
// 上线后质量卡（ADR-063 刀 1 · N-EVAL-POSTLAUNCH-K1 / CARDPIVOT）
// ----------------------------------------------------------------------------
// 跨会话，挂在遥测 tab 的会话列表上方。数据只有一条来路：telemetry_turn_scores
// 经 telemetry:get-postlaunch-report 出来的那份报告——卡片自己不算任何比率，
// 分母口径与本地表永远一致。
// 布局是透视：维度做行、分组（周 × app 版本 × 提示词版本）做列，时间从左到右，
// 每格挂与左邻列的百分点差。摆列与减法都在 postLaunchPivot.ts 那个纯函数里。
// 信号轮 / 抽样轮用分段控件切换、不合并：信号轮是被判有问题才评的，合并会把分布拉花。
// ============================================================================
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Play, Loader2 } from 'lucide-react';
import type { PostLaunchDimension, PostLaunchReport, PostLaunchScopeRow } from '@shared/contract/postLaunchScore';
import { POST_LAUNCH_DIMENSIONS } from '@shared/contract/postLaunchScore';
import { Modal } from '@renderer/components/primitives/Modal';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { pivotPostLaunchReport, type PostLaunchPivotColumn } from './postLaunchPivot';

type PostLaunchScope = PostLaunchScopeRow['scope'];

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

function columnLabel(column: PostLaunchPivotColumn): string {
  return [column.weekStart, column.appVersion, column.promptVersion].filter(Boolean).join(' · ');
}

export const PostLaunchCard: React.FC<PostLaunchCardProps> = ({
  report, running, error, days, onRun, onOpenSession,
}) => {
  const { t } = useEvaluationI18n();
  const p = t.telemetry.postLaunch;
  const [scope, setScope] = useState<PostLaunchScope>('sample');
  const [expanded, setExpanded] = useState(false);
  // 弹层认的是可见列的下标，切轮类型 / 展开更早都会让下标改指别的组，所以那两处一并关掉弹层。
  const [openColumn, setOpenColumn] = useState<number | null>(null);
  // IPC 回来的东西在信任边界之外：形状不对就当没有报告、渲染空态。
  // 一张卡片把整个遥测页崩掉，比它什么都不显示糟得多。
  const safe = report && Array.isArray(report.groups) && report.calibration && report.budget ? report : null;
  const pivot = useMemo(() => pivotPostLaunchReport(safe, scope, expanded), [safe, scope, expanded]);
  const hasGroups = Boolean(safe && safe.groups.length > 0);
  const sessionColumn = openColumn === null ? undefined : pivot.columns[openColumn];

  const switchScope = (next: PostLaunchScope) => {
    setScope(next);
    setOpenColumn(null);
  };

  const renderMetaRow = (
    testId: string,
    label: string,
    cell: (column: PostLaunchPivotColumn, index: number) => React.ReactNode,
  ) => (
    <tr data-testid={testId}>
      <th scope="row" className="py-1 pr-2 text-left align-top font-normal text-zinc-500">
        {label}
        <span className="block text-[9px] text-zinc-600">{p.wholeGroup}</span>
      </th>
      {pivot.columns.map((column, index) => (
        <td key={index} className={`py-1 pr-2 align-top ${column.lowSample ? 'text-zinc-600' : 'text-zinc-500'}`}>
          {/* 0 轮的列没有这一类轮可看，整组明细留 —，不拿别的轮类型的数字冒充 */}
          {column.empty ? p.noVerdict : cell(column, index)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-800/40 p-3" data-testid="postlaunch-card">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-zinc-300">
            {p.title}
            <span className="ml-1 font-normal text-zinc-500">· {p.groupBy}</span>
          </h3>
          <p className="text-[10px] text-zinc-500">{p.subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasGroups && (
            <div className="flex gap-0.5 rounded border border-zinc-700 bg-zinc-900 p-0.5" role="group" aria-label={p.scopeGroup}>
              {(['sample', 'signal'] as const).map((candidate) => (
                <button /* ds-allow:button: 遥测卡内 10px 微尺寸分段控件，Button primitive 无 segmented 变体 */
                  key={candidate}
                  type="button"
                  aria-pressed={scope === candidate}
                  onClick={() => switchScope(candidate)}
                  data-testid={`postlaunch-scope-${candidate}`}
                  className={`rounded px-2 py-0.5 text-[10px] ${scope === candidate ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400'}`}
                >
                  {candidate === 'signal' ? p.scopeSignal : p.scopeSample}
                </button>
              ))}
            </div>
          )}
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

      {!hasGroups && (
        <div className="py-6 text-center text-[11px] text-zinc-500" data-testid="postlaunch-empty">{p.empty}</div>
      )}

      {hasGroups && (
        <div data-testid={`postlaunch-panel-${scope}`}>
          <div className="mb-1 flex items-baseline gap-1 text-[10px]">
            <span className="text-zinc-400">
              {p.panelLabel.replace('{scope}', scope === 'signal' ? p.scopeSignal : p.scopeSample)}
            </span>
            <span className="text-zinc-600">· {p.panelHint}</span>
            {pivot.hiddenCount > 0 || expanded ? (
              <button /* ds-allow:button: 遥测卡内 10px 微尺寸行内动作，Button primitive 无对应变体 */
                type="button"
                onClick={() => { setExpanded(!expanded); setOpenColumn(null); }}
                data-testid="postlaunch-earlier"
                className="ml-auto rounded bg-zinc-700/60 px-1.5 py-0.5 text-zinc-300"
              >
                {expanded ? p.collapse : p.earlier}
              </button>
            ) : null}
          </div>

          <table className="w-full table-fixed text-[10px]">
            <thead>
              <tr>
                <th className="w-[16%] py-1 pr-2 text-left align-bottom font-normal text-zinc-500">{p.pivotHeader}</th>
                {pivot.columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={`py-1 pr-2 text-left align-bottom font-normal ${column.lowSample ? 'text-zinc-500' : 'text-zinc-300'}`}
                    data-testid={`postlaunch-col-${index}`}
                  >
                    <span className="block">{column.weekStart}</span>
                    <span className="block text-zinc-500">
                      {column.appVersion}{column.promptVersion ? ` · ${column.promptVersion}` : ''}
                    </span>
                    <span className="block">
                      {p.turns.replace('{n}', String(column.turns))}
                      {column.lowSample && (
                        <span className="ml-1 rounded border border-zinc-600 px-1 text-[9px] text-zinc-500">
                          {column.empty ? `${p.lowSample} · ${p.noTurns}` : p.lowSample}
                        </span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {POST_LAUNCH_DIMENSIONS.map((dimension: PostLaunchDimension) => (
                <tr key={dimension} data-testid={`postlaunch-row-${dimension}`}>
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-zinc-400">{p.dims[dimension]}</th>
                  {pivot.columns.map((column, index) => {
                    const cell = column.cells[dimension];
                    const latest = index === pivot.columns.length - 1;
                    return (
                      <td
                        key={index}
                        className={`py-1 pr-2 ${column.lowSample ? 'text-zinc-500' : 'text-zinc-300'}`}
                        data-testid={`postlaunch-cell-${dimension}-${index}`}
                      >
                        {/* 最新一列另挂 postlaunch-<scope>-<dim>：一屏一个「当下是多少」的锚 */}
                        <span data-testid={latest ? `postlaunch-${scope}-${dimension}` : undefined}>
                          {cell.rate === null ? p.noVerdict : `${cell.rate}%`}
                        </span>
                        {cell.delta !== null && (
                          <span
                            data-testid={`postlaunch-delta-${dimension}-${index}`}
                            title={cell.delta === 0
                              ? p.deltaFlatTitle
                              : p.deltaTitle
                                .replace('{current}', String(cell.rate))
                                .replace('{previous}', String((cell.rate ?? 0) - cell.delta))
                                .replace('{delta}', String(cell.delta))}
                            className={`ml-1.5 ${cell.delta < 0 ? 'text-badge-danger' : cell.delta > 0 ? 'text-badge-success' : 'text-zinc-600'}`}
                          >
                            {cell.delta === 0 ? p.deltaFlat : `${cell.delta < 0 ? '▼ ' : '▲ +'}${Math.abs(cell.delta)}`}
                            <span className="ml-0.5 text-[9px] text-zinc-600">{p.computed}</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tbody className="border-t border-zinc-800">
              {renderMetaRow('postlaunch-failure-classes', p.failureClasses, (column) => (
                column.failureClasses.length > 0
                  ? column.failureClasses.map((entry) => `${entry.code} ${entry.count}`).join(' · ')
                  : p.noVerdict
              ))}
              {renderMetaRow('postlaunch-signals', p.signals, (column) => (
                column.signals.length > 0
                  ? column.signals.map((entry) => `${entry.kind} ${entry.count}`).join(' · ')
                  : p.noVerdict
              ))}
              {renderMetaRow('postlaunch-cost', p.cost, (column) => `$${formatUsd(column.costUsd)}`)}
              {renderMetaRow('postlaunch-sessions', p.sessions, (column, index) => (
                column.sessionIds.length > 0 ? (
                  <button /* ds-allow:button: 遥测卡内 10px 微尺寸行内动作，Button primitive 无对应变体 */
                    type="button"
                    onClick={() => setOpenColumn(index)}
                    data-testid={`postlaunch-sessions-${index}`}
                    className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200"
                  >
                    {p.sessionsCount.replace('{n}', String(column.sessionIds.length))}
                  </button>
                ) : p.noVerdict
              ))}
            </tbody>
          </table>

          <p className="mt-1 text-[10px] text-zinc-600">{scope === 'signal' ? p.scopeNoteSignal : p.scopeNoteSample}</p>
          <p className="text-[10px] text-zinc-600">{p.pivotNote}</p>
          <p className="mt-1 text-[10px] text-zinc-600">{p.readingNote}</p>
        </div>
      )}

      {sessionColumn && (
        <Modal
          isOpen
          onClose={() => setOpenColumn(null)}
          size="lg"
          title={p.sessionsTitle
            .replace('{group}', columnLabel(sessionColumn))
            .replace('{n}', String(sessionColumn.sessionIds.length))}
        >
          <div className="flex flex-wrap gap-1">
            {sessionColumn.sessionIds.map((sessionId) => (
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
          <p className="mt-3 text-[10px] text-zinc-500">{p.sessionsNote}</p>
        </Modal>
      )}
    </div>
  );
};
