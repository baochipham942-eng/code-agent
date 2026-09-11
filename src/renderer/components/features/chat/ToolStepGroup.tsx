import { getToolPreflightKind, toolPreflightCopy } from '../../../utils/toolPreflightPresentation';
// ============================================================================
// ToolStepGroup - 把相邻的工具调用折成一行 "Explored 2 files, 2 lists"
// 默认折叠，点击展开显示原 ToolCallDisplay 列表
// ============================================================================

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import type { PermissionRequest, ToolCall, ToolLiveOutput, ToolStepStatus } from '@shared/contract';
import { findConnectorIdForToolName } from '@shared/contract/workbenchTools';
import {
  ToolCallDisplay,
  type ToolReceiptPresentation,
} from './MessageBubble/ToolCallDisplay/index';
import { computeBashPreviewLines } from './MessageBubble/ToolCallDisplay/bashOutputPreview';
import {
  classifyToolName,
  humanizeToolGroupLabel,
  humanizeToolStep,
  isInternalStreamTool,
} from '../../../utils/humanizeToolStep';
import {
  formatToolDuration,
  humanizeToolFailureReason,
  isAutoLoadedRetry,
  isEscalatedToolError,
} from '../../../utils/toolExecutionPresentation';
import { useI18n } from '../../../hooks/useI18n';
import { getDeferredContentStyle } from '../../../utils/turnContentVisibility';
import { getPlanApprovalRecord } from '../../../utils/planApprovalView';
import { PlanApprovalEvidence } from '../../PlanApprovalCard';
import { isDelegationTool } from '../../../utils/agentActivity';
import { getHumanToolLabel } from '../../../utils/toolHumanLabel';
import { useAppStore } from '../../../stores/appStore';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { Button } from '../../primitives/Button';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { isToolCallAwaitingApproval } from '../../../utils/sessionNeedsInput';

interface ToolStepGroupProps {
  nodes: TraceNode[];
  sessionId?: string;
  /** Streaming turn: default expanded so user sees live progress */
  defaultExpanded?: boolean;
  /** ADR-043：turn 仍在流式输出中——驱动中间档（Truncated）的自动展示 */
  isStreamingTurn?: boolean;
  /** 由 TurnCard 按 sourceNodeId 归并到本组的外部执行回执。 */
  receipts?: TurnArtifactOwnershipItem[];
  receiptTimestamp?: number;
}

const EMPTY_RESOLVED_PERMISSION_REQUESTS: PermissionRequest[] = [];

function resolveTraceToolStepStatus(
  toolCall: NonNullable<TraceNode['toolCall']>,
  awaitingApproval: boolean,
): ToolStepStatus {
  if (awaitingApproval) return 'pending-approval';
  if (toolCall.result === undefined) return 'running';
  return toolCall.success === false ? 'failed' : 'completed';
}

export const ToolStepGroup: React.FC<ToolStepGroupProps> = ({
  nodes: sourceNodes,
  sessionId,
  defaultExpanded = false,
  isStreamingTurn = false,
  receipts = [],
  receiptTimestamp,
}) => {
  const { t } = useI18n();
  const nodes = useMemo(() => sourceNodes.map((node) => {
    const tc = node.toolCall;
    if (!tc || getToolPreflightKind({ name: tc.name, result: tc.result === undefined ? undefined : {
      toolCallId: tc.id, success: tc.success ?? true, output: tc.result, metadata: tc.metadata,
    } }) !== 'question') return node;
    return { ...node, toolCall: { ...tc, success: false } };
  }), [sourceNodes]);
  const sendPrompt = useMessageActionStore((state) => state.sendPrompt);
  const resolvedPermissionRequests = useAppStore((state) => (
    sessionId ? state.resolvedPermissionRequests?.[sessionId] : undefined
  )) ?? EMPTY_RESOLVED_PERMISSION_REQUESTS;
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const permissionState = useMemo(() => ({
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
  }), [pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests]);
  // 主流可见节点：过滤 ToolSearch 等纯内部动作（仍可在混合组的展开明细里看到）
  const streamVisibleNodes = useMemo(
    () => nodes.filter((n) => {
      const name = n.toolCall?.name;
      return !name || !isInternalStreamTool(name);
    }),
    [nodes],
  );
  const label = useMemo(() => {
    if (streamVisibleNodes.length === 0) return '';
    if (streamVisibleNodes.length === 1) {
      const tc = streamVisibleNodes[0].toolCall;
      if (tc) {
        const connectorId = findConnectorIdForToolName(tc.name);
        const stepStatus = resolveTraceToolStepStatus(
          tc,
          isToolCallAwaitingApproval(tc.id, sessionId, permissionState),
        );
        const preflight = toolPreflightCopy({ name: tc.name, arguments: tc.args, result: tc.result === undefined ? undefined : {
          toolCallId: tc.id, success: tc.success ?? true, error: tc.success === false ? tc.result : undefined, output: tc.result, metadata: tc.metadata,
        } }, t);
        const step = preflight?.action ?? humanizeToolStep(
          tc.name,
          tc.args as Record<string, unknown> | undefined,
          t,
          tc.shortDescription,
          stepStatus,
          tc.stepLabel,
          { connectorPrefixRendered: Boolean(connectorId) },
        );
        if (!connectorId) return step;
        const connector = getHumanToolLabel({
          toolName: tc.name,
          labels: t.receiptPresentation.humanToolLabels,
        });
        return `${connector} · ${step}`;
      }
    }
    const names = streamVisibleNodes.flatMap((node) => node.toolCall ? [node.toolCall.name] : []);
    const connectorIds = new Set(names.map(findConnectorIdForToolName).filter(Boolean));
    if (connectorIds.size === 1 && names.every((name) => findConnectorIdForToolName(name))
      && streamVisibleNodes.every((node) => node.toolCall?.success === true)) {
      const connector = getHumanToolLabel({ toolName: names[0], labels: t.receiptPresentation.humanToolLabels });
      return `${connector} · ${t.toolGroup.executedSteps.replace('{count}', String(names.length))}`;
    }
    const byStatus = new Map<ToolStepStatus, string[]>();
    let blockedCommands = 0;
    let blockedSteps = 0;
    for (const node of streamVisibleNodes) {
      const tc = node.toolCall;
      if (!tc) continue;
      // 自动加载重试和已恢复的失败是良性/已收尾状态：**不按失败计**，但**仍要计数**。
      //  · 不按失败计——否则组状态是 ok（无红点、无原因行），组头却写「…未成功」，
      //    正好是 status 那边注释要防的「把成功的一轮演成翻车」。
      //  · 仍要计数——直接 continue 会让「WebSearch 失败 → WebFetch 失败 → 模型给出答案」
      //    这种整组都被过滤的情形 label 变成空串，撞上下面 `!label` 的守卫，整个工具组
      //    从时间线上消失，用户连「搜索发生过」都不知道。
      const benign = isAutoLoadedRetry(tc.metadata) || tc.recovered;
      const preflight = benign ? null : getToolPreflightKind({ name: tc.name, result: tc.result === undefined ? undefined : {
        toolCallId: tc.id, success: tc.success ?? true, error: tc.success === false ? tc.result : undefined, output: tc.result, metadata: tc.metadata,
      } });
      if (preflight) {
        if (classifyToolName(tc.name) === 'bash') blockedCommands += 1;
        else blockedSteps += 1;
        continue;
      }
      const stepStatus = benign
        ? 'completed'
        : resolveTraceToolStepStatus(tc, isToolCallAwaitingApproval(tc.id, sessionId, permissionState));
      byStatus.set(stepStatus, [...(byStatus.get(stepStatus) ?? []), tc.name]);
    }
    return [
      ...Array.from(byStatus, ([stepStatus, names]) => humanizeToolGroupLabel(names, t, stepStatus)),
      blockedCommands ? t.deliveryExperience.blockedCommands.replace('{count}', String(blockedCommands)) : '',
      blockedSteps ? t.deliveryExperience.blockedSteps.replace('{count}', String(blockedSteps)) : '',
    ].filter(Boolean).join(t.deliveryExperience.labelSeparator);
  }, [permissionState, sessionId, streamVisibleNodes, t]);

  const status = useMemo<'pending-approval' | 'streaming' | 'partial' | 'error' | 'ok'>(() => {
    let hasError = false;
    let hasSuccess = false;
    let hasRunning = false;
    for (const n of nodes) {
      const tc = n.toolCall;
      if (!tc) continue;
      // 自动加载重试 + 已恢复的失败都是良性/已收尾状态，不参与组状态判定
      // （否则组会卡 error/partial、顶红、一直展开，把成功的一轮演成翻车）。
      if (isAutoLoadedRetry(tc.metadata) || tc.recovered) continue;
      if (tc.result === undefined && isToolCallAwaitingApproval(tc.id, sessionId, permissionState)) {
        return 'pending-approval';
      }
      if (tc.result === undefined) {
        hasRunning = true;
        continue;
      }
      if (tc.success === false) hasError = true;
      if (tc.success === true || (tc.result !== undefined && tc.success !== false)) {
        hasSuccess = true;
      }
    }
    if (hasError && (hasSuccess || hasRunning)) return 'partial';
    if (hasError) return 'error';
    return hasRunning ? 'streaming' : 'ok';
  }, [nodes, permissionState, sessionId]);

  // 构造 ToolCallDisplay 需要的 ToolCall 对象
  const toolCalls = useMemo<ToolCall[]>(() => {
    return nodes
      .map((n) => {
        if (!n.toolCall) return null;
        const tc = n.toolCall;
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
          _streaming: tc._streaming,
          shortDescription: tc.shortDescription,
          stepLabel: tc.stepLabel,
          targetContext: tc.targetContext,
          expectedOutcome: tc.expectedOutcome,
          liveOutput: tc.liveOutput,
          result:
            tc.result !== undefined
              ? {
                  toolCallId: tc.id,
                  success: tc.success ?? true,
                  output: tc.success !== false ? tc.result : undefined,
                  error: tc.success === false ? tc.result : undefined,
                  duration: tc.duration,
                  outputPath: tc.outputPath,
                  metadata: tc.recovered
                    ? { ...(tc.metadata || {}), recovered: true }
                    : tc.metadata,
                }
              : undefined,
        } as ToolCall;
      })
      .filter((x): x is ToolCall => !!x);
  }, [nodes]);
  const receiptCacheRef = useRef(new Map<string, ToolReceiptPresentation>());
  const receiptByToolCallId = (() => {
    const liveToolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    for (const cachedToolCallId of receiptCacheRef.current.keys()) {
      if (!liveToolCallIds.has(cachedToolCallId)) receiptCacheRef.current.delete(cachedToolCallId);
    }
    for (const item of receipts) {
      const receipt = item.receipt;
      if (!receipt || !item.sourceNodeId) continue;
      const node = nodes.find((candidate) => candidate.id === item.sourceNodeId);
      const toolCallId = node?.toolCall?.id;
      if (!toolCallId) continue;
      receiptCacheRef.current.set(toolCallId, {
        status: receipt.status,
        detail: receipt.detail,
        sourceTool: receipt.sourceTool,
        connector: receipt.connector,
        createdAt: receiptTimestamp ?? node.timestamp,
      });
    }
    return new Map(receiptCacheRef.current);
  })();
  const interruptedNode = useMemo(
    () => nodes.find((node) => Boolean(
      node.toolCall
      && (node.metadata?.streamInterruptionReason || node.metadata?.streamRecovery),
    )),
    [nodes],
  );
  const permissionEvidence = useMemo(() => resolvedPermissionRequests.flatMap((request) => {
    if (!request.parentToolUseId) return [];
    const node = nodes.find((candidate) => candidate.toolCall?.id === request.parentToolUseId);
    const toolCall = node?.toolCall;
    if (!toolCall) return [];

    const p = t.decisionCard.permission;
    const requestDetails = request.details as Record<string, unknown>;
    const denied = request.decision === 'deny' || request.decision === 'never';
    const timedOut = request.decision === 'timeout';
    const statusLabel = timedOut ? p.settledTimeout : denied ? p.settledDenied : p.settledAllowed;
    const humanizedStep = humanizeToolStep(
      request.tool,
      requestDetails,
      t,
      toolCall.shortDescription,
      denied || timedOut ? 'failed' : 'completed',
      toolCall.stepLabel,
    );
    const connectorLabel = getHumanToolLabel({
      toolName: request.tool,
      labels: t.receiptPresentation.humanToolLabels,
    });
    const subject = typeof requestDetails.subject === 'string' ? requestDetails.subject.trim() : '';
    const stepLabel = request.tool === 'tmeetMeetingCreate'
      ? `${p.writeback.tmeetCreateTitle}${subject ? ` ${subject}` : ''}`
      : connectorLabel !== request.tool && !humanizedStep.includes(connectorLabel)
        ? `${connectorLabel} · ${humanizedStep}`
        : humanizedStep;
    const details = redactCredentialText(JSON.stringify(request.details, null, 2));

    return [{ request, statusLabel, stepLabel, details, timedOut, denied }];
  }), [nodes, resolvedPermissionRequests, t]);
  // 来自本组里一条已解析的 PermissionRequest——真的「有人/有界面做了这个决定」。
  // 只有它才可以抢在 failureReason 之前：仅凭 metadata.failureCode 的那种猜测（很可能是
  // CLI auto 档 fail-closed、从没到过人眼）由 humanizeToolFailureReason / preflight
  // 分类得更准，不该顶掉逐 toolCall 的原因。
  // （原先还挂了一档 toolFailureCode 兜底，已删：它不可达——那一行只在 status 为
  //   partial/error 时渲染，而那两种状态成立就必然存在 success===false 的 toolCall，
  //   failureReason 于是必非空，永远轮不到那一档。）
  const permissionRequestOutcome = permissionEvidence.some(({ denied }) => denied)
    ? t.outcomeWords['failed-approval-denied'].timeline
    : permissionEvidence.some(({ timedOut }) => timedOut)
      ? t.outcomeWords['failed-timeout'].timeline
      : null;
  const planApproval = useMemo(
    () => toolCalls.map(getPlanApprovalRecord).find((record) => record !== null) ?? null,
    [toolCalls],
  );

  // 组里是否存在需要用户介入的失败（鉴权失效/额度耗尽/限流），而非 agent 试错的
  // 探索性失败（工具未安装、非零退出码、反爬墙/限流类瞬态噪音等未分类错误）。
  // 产品拍板（正式推翻旧的"除纯网络抓取组外一律强制展开"设计）：只有需要用户介入
  // 的失败才默认展开+醒目；探索性失败一律默认折叠成一行，跟成功行视觉权重接近——
  // 折叠态下点开仍能看到完整的脱敏恢复步骤/成败明细，信息不丢，只是不强制摊开。
  const hasEscalatedError = useMemo(
    () => toolCalls.some((tc) => isEscalatedToolError(tc)),
    [toolCalls],
  );
  const forceExpandOnFailure = (status === 'error' || status === 'partial') && hasEscalatedError;
  const [expanded, setExpanded] = useState(defaultExpanded || forceExpandOnFailure);
  // 用户手动点过展开/收起后冻结自动档，不再被流式中间档/流式收尾自动切换抢走（ADR-043 决策 2/3）。
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (forceExpandOnFailure) {
      setExpanded(true);
    }
  }, [forceExpandOnFailure]);

  // 正在运行的那一步 = 组内最后一个还没有 result 的 toolCall（真实"在跑"信号，
  // 不是 tc._streaming 参数流标记——同一工具参数流完时 result 仍未到位也算在跑）。
  const runningToolCall = useMemo<ToolCall | null>(() => {
    for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
      if (toolCalls[i].result === undefined) return toolCalls[i];
    }
    return null;
  }, [toolCalls]);
  const completedStepsCount = useMemo(
    () => toolCalls.filter((tc) => tc.result !== undefined).length,
    [toolCalls],
  );
  const isFailureStatus = status === 'error' || status === 'partial';
  const needsUserActionShell = isFailureStatus && hasEscalatedError;
  // 三态档位（ADR-043）：需介入失败/用户已展开 → 全展开；未冻结且流式中且有正在跑的
  // 一步且组内还没出现失败 → 中间档；其余 → 收起。中间档不进 aria-expanded 语义。
  const tier: 'collapsed' | 'truncated' | 'expanded' = forceExpandOnFailure || expanded
    ? 'expanded'
    : !userToggled && isStreamingTurn && runningToolCall && !isFailureStatus
      ? 'truncated'
      : 'collapsed';
  const ariaExpanded = tier === 'expanded';

  // 中间档专用：实时输出截尾 5 行（ADR-043 决策 4，复用 bashOutputPreview 里
  // isPending=true 的现成尾部截断，不新造截断逻辑）。全展开态用原始 runningToolCall——
  // 这里不重复截断，但 LiveToolOutput 自身现在也做同一套尾截断（遗留刀1），
  // 所以两层截断在全展开态下是等效的，不是"不受影响/无上限"。
  const truncatedRunningToolCall = useMemo<ToolCall | null>(() => {
    if (tier !== 'truncated' || !runningToolCall) return null;
    return { ...runningToolCall, liveOutput: tailTruncateLiveOutput(runningToolCall.liveOutput) };
  }, [tier, runningToolCall]);

  const failureReason = useMemo(() => {
    // 与组头 label 同口径：已恢复/自动重试的失败不算数，否则会出现 label 说「1 条未成功」、
    // 原因行说「2 失败」这种自相矛盾。
    const failedCalls = toolCalls.filter((toolCall) => toolCall.result?.success === false
      && !isAutoLoadedRetry(toolCall.result?.metadata) && toolCall.result?.metadata?.recovered !== true);
    if (failedCalls.length === 0) return null;
    if (failedCalls.length === 1) return humanizeToolFailureReason(failedCalls[0], t);
    return t.toolGroup.summaryFailed.replace('{count}', String(failedCalls.length));
  }, [t, toolCalls]);
  const outputCount = useMemo(() => {
    return toolCalls.filter((toolCall) => hasToolOutputArtifact(toolCall)).length;
  }, [toolCalls]);
  // 结局优先：这组里有多少次失败已被后续成功恢复——只用于安静地标个「已恢复」，不顶红。
  const recoveredCount = useMemo(
    () => nodes.filter((n) => n.toolCall?.recovered).length,
    [nodes],
  );
  const totalDuration = useMemo(() => {
    const total = toolCalls.reduce((sum, toolCall) => sum + (toolCall.result?.duration ?? 0), 0);
    return total > 0 ? formatToolDuration(total) : null;
  }, [toolCalls]);

  // 纯内部动作组：不渲染主流行（对齐「内部流水不进用户主视角」）。
  // 必须放在全部 hooks 之后，避免条件性调用 hooks。
  if (planApproval && toolCalls.length === 1) {
    return planApproval.status === 'pending' ? null : <PlanApprovalEvidence approval={planApproval} />;
  }
  if (streamVisibleNodes.length === 0 || !label) {
    return null;
  }
  if (toolCalls.length === 1 && interruptedNode) {
    const toolCall = toolCalls[0];
    return (
      <div className="my-0.5">
        <ToolCallDisplay
          toolCall={toolCall}
          index={0}
          total={1}
          compact
          statusOverride="interrupted"
          interruptionReason={interruptedNode.metadata?.streamInterruptionReason ?? 'app-restart'}
          mediaContext={{
            sessionId,
            messageId: interruptedNode.messageId || toolCall.id,
          }}
        />
      </div>
    );
  }

  if (toolCalls.length === 1 && isDelegationTool(toolCalls[0].name)) {
    const toolCall = toolCalls[0];
    return (
      <div
        className="my-0.5"
        data-deferred-content={!isStreamingTurn ? 'tool-card' : undefined}
        style={!isStreamingTurn ? getDeferredContentStyle('toolCard') : undefined}
      >
        <ToolCallDisplay
          toolCall={toolCall}
          index={0}
          total={1}
          compact
          mediaContext={{
            sessionId,
            messageId: nodes.find((node) => node.toolCall?.id === toolCall.id)?.messageId || toolCall.id,
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="my-0.5"
      data-deferred-content={!isStreamingTurn ? 'tool-card' : undefined}
      style={!isStreamingTurn ? getDeferredContentStyle('toolCard') : undefined}
    >
      <button
        onClick={() => {
          setUserToggled(true);
          setExpanded((value) => !value);
        }}
        // leading-4：行内文字行高压到 16px，chevron（12px）与文字视觉中线对齐——
        // 此前继承祖先的宽松行高，文字 glyph 在更高的行盒里下沉，chevron 看起来上飘。
        // UX round2 20i：ok 行文字从 zinc-600 提到 zinc-400（「搜索通话字幕原文」这类行太暗看不清）。
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[11px] leading-4 transition-colors group ${
          needsUserActionShell
            ? 'border border-badge-danger/30 bg-red-400/[0.05] px-2 py-1 text-zinc-500 hover:border-badge-danger/45 hover:bg-red-400/[0.08] hover:text-zinc-300'
            : 'px-1 py-0.5 text-zinc-400 hover:bg-surface-subtle hover:text-zinc-300'
        }`}
        aria-expanded={ariaExpanded}
      >
        {ariaExpanded ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0 self-center text-zinc-500" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0 self-center text-zinc-500" />
        )}
        {status === 'error' && (
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasEscalatedError ? 'bg-mark-danger' : 'bg-zinc-500'}`}
            aria-label={t.toolGroup.statusFailed}
          />
        )}
        {status === 'partial' && (
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasEscalatedError ? 'bg-mark-warning' : 'bg-zinc-500'}`}
            aria-label={t.toolGroup.statusPartial}
          />
        )}
        <span className="min-w-0 flex-1">
          {/* data-testid 是给 tests/e2e/tool-group-header-alignment.spec.ts（#1002 的排版几何
              护栏）用的稳定锚点。原先那条 spec 按 truncate / flex-shrink-0 两个**样式类**定位，
              组头一改版就找不到元素、静默失效——而 test:swarm:e2e 不含它，PR CI 也不会红。
              锚点要钉在身份上，不是钉在它此刻长什么样。 */}
          <span data-testid="tool-group-head-label" className="block break-words text-xs leading-5">{status === 'pending-approval' ? <span data-testid="tool-group-head-status">{`${t.toolStepHumanize.pendingApprovalStatus} · `}</span> : status === 'streaming' ? <span data-testid="tool-group-head-status">{`${t.toolGroup.statusRunning} · `}</span> : ''}{label}</span>
          {(status === 'partial' || status === 'error') && (
            <span className={`mt-0.5 block whitespace-normal break-words text-xs leading-5 ${hasEscalatedError ? 'text-badge-danger' : 'text-zinc-400'}`}>
              {status === 'partial' ? `${t.toolGroup.statusPartial} · ` : ''}
              {permissionRequestOutcome?.reason ?? failureReason ?? t.toolStepHumanize.failureReasonMissing}
            </span>
          )}
        </span>
        {recoveredCount > 0 && (
          <span
            className="flex-shrink-0 rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-zinc-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            title={t.toolGroup.recoveredTitle}
          >
            {t.toolGroup.recovered}
          </span>
        )}
        {status !== 'ok' && outputCount > 0 && (
          <span className="flex-shrink-0 rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-zinc-500">{t.toolGroup.outputCount.replace('{count}', String(outputCount))}</span>
        )}
        {totalDuration && (
          <span
            className="min-w-[4ch] flex-shrink-0 text-right text-[10px] text-zinc-600"
            title={t.toolGroup.durationTitle}
          >
            {totalDuration}
          </span>
        )}
      </button>

      {permissionEvidence.map(({ request, statusLabel, stepLabel, details, timedOut, denied }) => (
        <div
          key={request.id}
          className="ml-4 flex items-start gap-2 pl-3 text-[11px] leading-5 text-zinc-500"
          data-testid="permission-decision-evidence"
        >
          <details className="min-w-0 flex-1" data-testid="permission-decision-details">
            <summary className="cursor-pointer list-none truncate hover:text-zinc-300">
              {denied
                ? `${t.outcomeWords['failed-approval-denied'].timeline.label} · ${t.outcomeWords['failed-approval-denied'].timeline.reason} · ${stepLabel}`
                : timedOut
                  ? `${t.outcomeWords['failed-timeout'].timeline.label} · ${t.outcomeWords['failed-timeout'].timeline.reason} · ${stepLabel}`
                  : `${statusLabel} · ${stepLabel}`}
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border-subtle bg-surface-primary px-2 py-1.5 text-[10px] leading-4 text-zinc-500">
              {details}
            </pre>
          </details>
          {timedOut && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 shrink-0 px-1.5 py-0 text-[10px]"
              leftIcon={<RotateCcw className="h-3 w-3" />}
              onClick={() => void sendPrompt(t.decisionCard.permission.retryPrompt)}
            >
              {t.decisionCard.permission.retry}
            </Button>
          )}
        </div>
      ))}

      {tier === 'truncated' && (
        <div className="ml-4 mt-1 space-y-1 pl-3">
          {truncatedRunningToolCall && (
            <ToolCallDisplay
              toolCall={truncatedRunningToolCall}
              index={0}
              total={1}
              compact
              mediaContext={{
                sessionId,
                messageId:
                  nodes.find((node) => node.toolCall?.id === truncatedRunningToolCall.id)?.messageId ||
                  truncatedRunningToolCall.id,
              }}
            />
          )}
          {completedStepsCount > 0 && (
            <div className="pl-1 text-[10px] text-zinc-600">
              {t.toolGroup.completedSteps.replace('{count}', String(completedStepsCount))}
            </div>
          )}
        </div>
      )}

      {tier === 'expanded' && (
        <div className="ml-4 mt-1 space-y-1 border-l border-zinc-800 pl-3">
          {toolCalls.map((tc, i) => (
            <div
              key={tc.id}
              data-trace-id={typeof tc.result?.metadata?.traceId === 'string' ? tc.result.metadata.traceId : undefined}
            >
              <ToolCallDisplay
                toolCall={tc}
                index={i}
                total={toolCalls.length}
                compact
                mediaContext={{
                  sessionId,
                  messageId: nodes.find((node) => node.toolCall?.id === tc.id)?.messageId || tc.id,
                }}
                receipt={receiptByToolCallId.get(tc.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function hasToolOutputArtifact(toolCall: ToolCall): boolean {
  if (toolCall.result?.outputPath) return true;
  const metadata = toolCall.result?.metadata;
  if (!metadata) return false;

  // `Read`/search tools often attach `metadata.filePath` for evidence context.
  // That is an input/evidence path, not a newly produced output artifact.
  if (isReadOrSearchTool(toolCall.name)) return false;

  return ['filePath', 'imagePath', 'videoPath', 'outputPath', 'pptxPath', 'pdfPath']
    .some((key) => typeof metadata[key] === 'string' && metadata[key]);
}

function isReadOrSearchTool(name: string): boolean {
  return [
    'Read',
    'read_file',
    'Grep',
    'Glob',
    'LS',
    'list_directory',
  ].includes(name);
}

/**
 * 中间档实时输出截尾（ADR-043 决策 4）：stdout/stderr 各自只留最后 5 行，
 * 复用 bashOutputPreview.ts 的 isPending=true 分支（"运行中尾 5 行"），不新造截断逻辑。
 * 纯函数，便于单测。
 */
export function tailTruncateLiveOutput(live: ToolLiveOutput | undefined): ToolLiveOutput | undefined {
  if (!live) return live;
  return {
    ...live,
    stdout: live.stdout ? computeBashPreviewLines(live.stdout, true).displayLines.join('\n') : live.stdout,
    stderr: live.stderr ? computeBashPreviewLines(live.stderr, true).displayLines.join('\n') : live.stderr,
  };
}
