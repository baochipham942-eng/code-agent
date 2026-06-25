// ============================================================================
// useTurnProjection - Project messages[] into TraceTurns
// Pure derivation via useMemo, no new state or store
// ============================================================================

import { useMemo } from 'react';
import type { Message } from '@shared/contract';
import type { TraceProjection, TraceTurn, TraceNode } from '@shared/contract/trace';
import type { SwarmLaunchRequest } from '@shared/contract/swarm';
import { isSkillStatusContent } from '../components/features/chat/MessageBubble/SkillStatusMessage';
import { isGoalNoticeContent } from '../components/features/chat/goalNotice';
import { isModelFallbackNoticeContent } from '../components/features/chat/fallbackNotice';
import { measureStreamingPerformanceTiming } from '../utils/streamingPerformanceMetrics';
import { isToolResultEcho } from '../utils/toolResultEcho';

type MessageModelDecision = NonNullable<Message['modelDecision']>;

function buildModelDecisionProjectionKey(decision: MessageModelDecision): string {
  const health = decision.providerHealthSnapshot;
  const tools = decision.toolStrategy;
  const savings = tools?.tokenSavings;
  const measurement = savings?.measurement;
  const providerIdentity = decision.providerIdentity;
  const engine = decision.externalEngine;
  const reliability = engine?.reliability;
  const failure = engine?.failure;

  return JSON.stringify({
    route: [
      decision.reason,
      decision.requestedProvider,
      decision.requestedModel,
      decision.resolvedProvider,
      decision.resolvedModel,
      decision.billingMode,
      decision.fallbackFrom,
    ],
    strategy: [
      decision.strategySummary,
      decision.taskClass,
      decision.costPolicy,
      decision.speedPolicy,
      decision.toolPolicy,
      decision.capabilityNeeds,
    ],
	    // 只保留分类态（provider/status），不放 sampledAt/latency/errorRate 这类每次采样都变的
	    // 遥测——否则同一个"用户选择 mimo"决策每轮 key 都不同，去重永远失效，chip 重复刷屏。
	    health: health ? [health.provider, health.status] : null,
	    providerIdentity: providerIdentity
	      ? [
	          providerIdentity.provider,
	          providerIdentity.displayName,
	          providerIdentity.sourceLabel,
	          providerIdentity.protocol,
	          providerIdentity.transportLabel,
	          providerIdentity.endpoint,
	        ]
	      : null,
	    // token 数值（savedTokens/providerUsage/...）每轮都变，不入 key；只保留工具结构性字段
    // 和 savings 的分类态/来源，保证"决策本质没变"时能正确去重。
    tools: tools
      ? [
          tools.visibleToolCount,
          tools.mcpToolCount,
          tools.mcpServerIds,
          tools.programmaticToolCalling,
          tools.programmaticToolCount,
          savings?.status,
          measurement?.savingsSource,
          measurement?.usageSource,
          savings?.providerReport?.source,
        ]
      : null,
    engine: engine
      ? [
          engine.kind,
          engine.installState,
          engine.runtimeState,
          engine.executable,
          engine.model,
          engine.version,
          engine.capabilities,
          reliability?.cliStatus,
          reliability?.authState,
          reliability?.quotaState,
          reliability?.streamingMode,
          reliability?.toolSupport,
          reliability?.transcriptMode,
          reliability?.partialMessages,
          reliability?.mcpBridge,
          failure?.category,
          failure?.reason,
          failure?.retryable,
          failure?.statusCode,
          failure?.exitCode,
          failure?.reliability?.authState,
          failure?.reliability?.quotaState,
          failure?.reliability?.cliStatus,
        ]
      : null,
  });
}

export function projectTurns(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean,
  launchRequests: SwarmLaunchRequest[] = [],
): TraceProjection {
  return measureStreamingPerformanceTiming('stream.projection.base_ms', () => {
  if (!sessionId) {
    return { sessionId: '', turns: [], activeTurnIndex: -1 };
  }

  const turns: TraceTurn[] = [];
  let currentTurn: TraceTurn | null = null;
  let turnCounter = 0;
  // 连续相同的模型路由决策只显示首个——agent 一个 turn 内多次 LLM 调用会各发一条
  // "用户选择 mimo"，重复刷没意义；模型变化（降级/角色档位）时 key 不同会照常显示。
  let lastModelDecisionKey: string | null = null;

  for (const msg of messages) {
    if (msg.source === 'skill' && isSkillStatusContent(msg.content)) {
      const node: TraceNode = {
        id: msg.id,
        type: 'system',
        content: msg.content,
        timestamp: msg.timestamp,
        subtype: 'skill_status',
        metadata: msg.metadata,
      };

      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);
      }

      currentTurn.nodes.push(node);
      currentTurn.endTime = msg.timestamp;
      continue;
    }

    if (msg.source === 'goal' && isGoalNoticeContent(msg.content)) {
      const node: TraceNode = {
        id: msg.id,
        type: 'system',
        content: msg.content,
        timestamp: msg.timestamp,
        subtype: 'goal_notice',
        metadata: msg.metadata,
      };

      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);
      }

      currentTurn.nodes.push(node);
      currentTurn.endTime = msg.timestamp;
      continue;
    }

    if (msg.source === 'model' && isModelFallbackNoticeContent(msg.content)) {
      const node: TraceNode = {
        id: msg.id,
        type: 'system',
        content: msg.content,
        timestamp: msg.timestamp,
        subtype: 'model_fallback',
        metadata: msg.metadata,
      };

      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);
      }

      currentTurn.nodes.push(node);
      currentTurn.endTime = msg.timestamp;
      continue;
    }

    if (msg.isMeta && msg.metadata?.automation) {
      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);
      }
      currentTurn.nodes.push({
        id: `${msg.id}-automation`,
        messageId: msg.id,
        type: 'assistant_text',
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
      });
      currentTurn.endTime = msg.timestamp;
      continue;
    }

    // Skip other isMeta messages (Skill system internal)
    if (msg.isMeta) continue;
    // Skip tool role messages (results shown in toolCalls)
    if (msg.role === 'tool') continue;

    // Compaction → system node, attach to current turn or create standalone
    if (msg.compaction) {
      const node: TraceNode = {
        id: `${msg.id}-compaction`,
        type: 'system',
        content: msg.compaction.content,
        timestamp: msg.timestamp,
        subtype: 'compaction',
      };
      if (currentTurn) {
        currentTurn.nodes.push(node);
      } else {
        turnCounter++;
        turns.push({
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [node],
          status: 'completed',
          startTime: msg.timestamp,
          endTime: msg.timestamp,
        });
      }
      continue;
    }

    // System messages → skip (nudges, recovery hints)
    if (msg.role === 'system') continue;

    // Runtime supplements are part of the in-flight task, not a new turn.
    const runtimeInputMode = msg.metadata?.workbench?.runtimeInputMode;
    if (
      msg.role === 'user'
      && runtimeInputMode === 'supplement'
      && msg.metadata?.workbench?.runtimeInputDelivery !== 'queued_next_turn'
      && currentTurn
    ) {
      currentTurn.nodes.push({
        id: msg.id,
        type: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
        attachments: msg.attachments,
        metadata: msg.metadata,
      });
      continue;
    }

    // User message → start a new turn
    if (msg.role === 'user') {
      // Close previous turn
      if (currentTurn) {
        currentTurn.status = 'completed';
        if (currentTurn.nodes.length > 0) {
          currentTurn.endTime = currentTurn.nodes[currentTurn.nodes.length - 1].timestamp;
        }
      }

      turnCounter++;
      currentTurn = {
        turnNumber: turnCounter,
        turnId: `turn-${turnCounter}`,
        nodes: [],
        status: 'completed',
        startTime: msg.timestamp,
      };
      turns.push(currentTurn);

      currentTurn.nodes.push({
        id: msg.id,
        type: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
        attachments: msg.attachments,
        metadata: msg.metadata,
      });
      continue;
    }

    // Assistant message → add nodes to current turn
    if (msg.role === 'assistant') {
      // If no current turn (e.g. assistant message without preceding user), create one
      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);
      }

      const hasContent = msg.content && msg.content.trim().length > 0;
      const hasReasoning = Boolean(
        msg.reasoning?.trim().length || msg.thinking?.trim().length,
      );
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

      // Skip empty assistant messages
      if (!hasContent && !hasReasoning && !hasToolCalls) continue;

      const turn = currentTurn;

      const pushAssistantTextNode = (content: string, index?: number) => {
        // 模型回显：小模型有时把工具结果 JSON 当正文复述，整段吞掉不当答案渲染。
        if (isToolResultEcho(content)) return;
        // 去重：连续相同的模型决策只在首个节点显示，避免每条消息都刷"用户选择 mimo"
        // 但策略解释字段变化时必须保留，否则 external engine / billing / fallback 诊断会被压掉。
        let modelDecision = msg.modelDecision;
        if (modelDecision) {
          const key = buildModelDecisionProjectionKey(modelDecision);
          if (key === lastModelDecisionKey) {
            modelDecision = undefined;
          } else {
            lastModelDecisionKey = key;
          }
        }
        turn.nodes.push({
          id: index && index > 1 ? `${msg.id}-text-${index}` : `${msg.id}-text`,
          messageId: msg.id,
          type: 'assistant_text',
          content,
          timestamp: msg.timestamp,
          reasoning: msg.reasoning,
          thinking: msg.thinking,
          artifacts: msg.artifacts,
          modelDecision,
          metadata: msg.metadata,
        });
      };

      const pushToolCallNode = (tc: NonNullable<Message['toolCalls']>[number]) => {
        turn.nodes.push({
          id: `${msg.id}-tc-${tc.id}`,
          type: 'tool_call',
          content: '',
          timestamp: msg.timestamp,
          toolCall: {
            id: tc.id,
            name: tc.name,
            args: tc.arguments,
            result: tc.result?.output || tc.result?.error,
            success: tc.result?.success,
            duration: tc.result?.duration,
            outputPath: tc.result?.outputPath,
            metadata: tc.result?.metadata,
            liveOutput: tc.liveOutput,
            _streaming: tc._streaming,
            shortDescription: tc.shortDescription,
            targetContext: tc.targetContext,
            expectedOutcome: tc.expectedOutcome,
          },
          metadata: msg.metadata,
        });
      };

      const contentParts = msg.contentParts ?? [];
      const toolCallsById = new Map((msg.toolCalls ?? []).map((tc) => [tc.id, tc]));
      const referencedToolCallIds = new Set<string>();
      const hasOrderedParts = contentParts.some((part) => part.type === 'tool_call');

      if (hasOrderedParts) {
        let textIndex = 0;
        let usedFallbackContent = false;
        const hasNonEmptyPartText = contentParts.some((part) => (
          part.type === 'text' && part.text.trim().length > 0
        ));
        const hasAnyTextPart = contentParts.some((part) => part.type === 'text');

        // 思考先于工具：纯工具调用消息（content_parts 无任何 text part）若带 reasoning，
        // 必须在工具节点之前放一个空正文节点承载 ▶思考——否则会被尾随到工具行之后，
        // 渲染成"搜索完成"排在"第一轮思考"前面（顺序明显错误）。有 text part 时由下方
        // 循环的首个文本节点携带 reasoning（同样在工具之前），无需在此预放。
        if (hasReasoning && !hasAnyTextPart) {
          pushAssistantTextNode('');
          textIndex += 1;
        }

        for (const part of contentParts) {
          if (part.type === 'text') {
            const textContent: string = part.text || (!hasNonEmptyPartText && !usedFallbackContent ? msg.content : '');
            usedFallbackContent = usedFallbackContent || Boolean(textContent);
            if (textContent.trim().length > 0 || (hasReasoning && textIndex === 0)) {
              textIndex += 1;
              pushAssistantTextNode(textContent, textIndex);
            }
            continue;
          }

          const tc = toolCallsById.get(part.toolCallId);
          if (!tc) continue;
          referencedToolCallIds.add(part.toolCallId);
          pushToolCallNode(tc);
        }

        for (const tc of msg.toolCalls ?? []) {
          if (!referencedToolCallIds.has(tc.id)) pushToolCallNode(tc);
        }

        // content_parts 是权威交错顺序。走到这里若仍 textIndex===0，说明 parts 里没有
        // 任何 text part：不能把内存里残留的 msg.content 当尾随正文追加到工具行之后——
        // 流式期模型先吐的 preamble（如"使用Write工具来创建文件"）被服务端精简成纯工具
        // 调用后，content 仍残留在内存（落库为空），尾随渲染会让它悬在工具行下方、刷新即
        // 消失。reasoning 已在循环前以「思考先于工具」的顺序放置，这里不再补任何节点。
        continue;
      }

      if (hasContent || hasReasoning) {
        pushAssistantTextNode(msg.content);
      }

      for (const tc of msg.toolCalls ?? []) {
        pushToolCallNode(tc);
      }
    }
  }

  const pendingLaunchRequest = [...launchRequests]
    .reverse()
    .find((request) => request.status === 'pending' && request.sessionId === sessionId);
  if (pendingLaunchRequest) {
    const launchNode: TraceNode = {
      id: `swarm-launch-${pendingLaunchRequest.id}`,
      type: 'swarm_launch_request',
      content: pendingLaunchRequest.summary,
      timestamp: pendingLaunchRequest.requestedAt,
      launchRequest: pendingLaunchRequest,
    };

    if (currentTurn) {
      currentTurn.nodes.push(launchNode);
      currentTurn.endTime = pendingLaunchRequest.requestedAt;
    } else {
      turnCounter++;
      currentTurn = {
        turnNumber: turnCounter,
        turnId: `turn-${turnCounter}`,
        nodes: [launchNode],
        status: 'completed',
        startTime: pendingLaunchRequest.requestedAt,
        endTime: pendingLaunchRequest.requestedAt,
      };
      turns.push(currentTurn);
    }
  }

  // Direct-routed sidecar messages should not steal the active marker from
  // the in-flight task. Normal user turns can still be active while waiting
  // for the first assistant response.
  let activeTurnIndex = -1;
  if (isProcessing && turns.length > 0) {
    const latestTurn = turns[turns.length - 1];
    const latestNode = latestTurn.nodes[latestTurn.nodes.length - 1];
    const directRoutingDelivery = latestNode?.metadata?.workbench?.directRoutingDelivery;
    const isDirectRoutedUserTurn =
      latestNode?.type === 'user' &&
      latestNode.metadata?.workbench?.routingMode === 'direct' &&
      (directRoutingDelivery?.deliveredTargetIds?.length || 0) > 0;

    if (latestNode?.type === 'user' && !isDirectRoutedUserTurn) {
      latestTurn.status = 'streaming';
      activeTurnIndex = turns.length - 1;
    }

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (activeTurnIndex >= 0) break;
      const candidateTurn = turns[index];
      const lastNode = candidateTurn.nodes[candidateTurn.nodes.length - 1];
      if (!lastNode) continue;

      if (lastNode.type === 'assistant_text' || lastNode.type === 'tool_call') {
        candidateTurn.status = 'streaming';
        activeTurnIndex = index;
        break;
      }
    }
  } else if (currentTurn) {
    currentTurn.status = 'completed';
    if (currentTurn.nodes.length > 0) {
      currentTurn.endTime = currentTurn.nodes[currentTurn.nodes.length - 1].timestamp;
    }
  }

  markFeedbackEligibleNodes(turns);
  markRecoveredFailures(turns);

  return {
    sessionId,
    turns,
    activeTurnIndex,
  };
  });
}

function markFeedbackEligibleNodes(turns: TraceTurn[]): void {
  for (const turn of turns) {
    let eligibleNode: TraceNode | undefined;
    for (const node of turn.nodes) {
      if (node.type === 'tool_call') {
        eligibleNode = undefined;
        continue;
      }

      if (node.type === 'assistant_text' && node.content.trim().length > 0) {
        eligibleNode = node;
      }
    }

    for (const node of turn.nodes) {
      if (node.type === 'assistant_text') {
        node.feedbackEligible = turn.status === 'completed' && node === eligibleNode;
      }
    }
  }
}

/**
 * 结局优先：若一次失败的工具调用之后，同一轮里又出现了"成功标志"（成功的工具调用，
 * 或非空的助手正文/最终答案），说明这次失败已被恢复——标记 recovered，让 UI 把它降级
 * 为安静脚注，而不是用最差的中间步骤顶着红色 failed 当整轮头条。
 *
 * 仅对【联网检索类工具】（web search / fetch）做降级——这类"换搜索源/换抓取方式重试"
 * 是常态恢复模式。Edit/Bash 这类的失败即便后面有别的成功也可能是独立真错误，不降级，
 * 以免把用户该看到的真失败藏掉。
 */
function isRecoverableRetrievalTool(name: string | undefined): boolean {
  if (!name) return false;
  return /web|search|fetch|tavily|exa|perplexity|brave/i.test(name);
}

function markRecoveredFailures(turns: TraceTurn[]): void {
  for (const turn of turns) {
    let laterSuccess = false;
    // 从后往前扫：到达某个失败工具节点时，laterSuccess 已反映它"之后"是否出现过成功标志。
    for (let i = turn.nodes.length - 1; i >= 0; i -= 1) {
      const node = turn.nodes[i];
      const isSuccessMarker =
        (node.type === 'assistant_text' && Boolean(node.content?.trim())) ||
        (node.type === 'tool_call' && node.toolCall?.success === true);
      if (
        node.type === 'tool_call' &&
        node.toolCall?.success === false &&
        laterSuccess &&
        isRecoverableRetrievalTool(node.toolCall.name)
      ) {
        node.toolCall.recovered = true;
      }
      if (isSuccessMarker) laterSuccess = true;
    }
  }
}

export function useTurnProjection(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean,
  launchRequests: SwarmLaunchRequest[] = [],
): TraceProjection {
  return useMemo(
    () => projectTurns(messages, sessionId, isProcessing, launchRequests),
    [messages, sessionId, isProcessing, launchRequests],
  );
}
