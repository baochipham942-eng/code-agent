// ============================================================================
// useTurnProjection - Project messages[] into TraceTurns
// Pure derivation via useMemo, no new state or store
// ============================================================================

import { useMemo } from 'react';
import type { Message, MessageMetadata } from '@shared/contract';
import {
  findRegisteredSystemEvent,
  findUnregisteredSystemEventKeys,
} from '@shared/contract/systemEventRegistry';
import type { NeoWorkCardDetail } from '@shared/contract/tag';
import type { TraceProjection, TraceTurn, TraceNode } from '@shared/contract/trace';
import type { SwarmLaunchRequest } from '@shared/contract/swarm';
import { isSkillStatusContent } from '../components/features/chat/MessageBubble/SkillStatusMessage';
import { isGoalNoticeContent } from '../components/features/chat/goalNotice';
import { isModelFallbackNoticeContent } from '../components/features/chat/fallbackNotice';
import { measureStreamingPerformanceTiming } from '../utils/streamingPerformanceMetrics';
import { isToolResultEcho } from '../utils/toolResultEcho';
import { getReasoningLiveNodeId } from '../utils/streamingProjectionOverlay';

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
  neoWorkCards: NeoWorkCardDetail[] = [],
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

    // 用户可见 system 事件：登记制（P0-2）。role:'system' 的落库消息默认是只给模型看的
    // 内部指令（真库 635 条 metadata 全 NULL），谁该给用户看由写入侧的登记表
    //（shared/contract/systemEventRegistry）决定，这里只查表：
    // - 已登记：按表里的呈现类型/挂轮策略投影（通话摘要、通话失败 #908、派活失败 W6-5、
    //   派活结局印章 X5.5-A2-a）；
    // - 未登记但带「事件性」metadata 键：开发档 console.error（契约测试同步报红），
    //   意思是「有人新写了用户可见事件却没登记」；生产档维持现状跳过。
    // 总闸不拆：未匹配的 system 消息一律 continue，绝不外泄给用户。
    if (msg.role === 'system') {
      const event = findRegisteredSystemEvent(msg.metadata);
      if (!event) {
        reportUnregisteredSystemEventMetadata(msg);
        continue;
      }
      const { spec, payload } = event;
      // settle 类（派活结局印章 X5.5-A2-a）：不是对话内容，不成节点——只把结局盖到
      // 按 workItemId 对回的派活轮上，任务卡据此报结局。对不上任何一轮就丢弃：
      // 宁可卡上不显示结局，也不能把印章盖到别人的活头上。
      if (spec.presentation === 'settle') {
        const settled = payload as NonNullable<MessageMetadata['voiceWorkSettled']>;
        const matchedTurn = findVoiceWorkTurn(turns, settled.workItemId);
        if (matchedTurn) matchedTurn.voiceWorkOutcome = settled.outcome;
        continue;
      }
      const node: TraceNode = {
        id: msg.id,
        type: 'system',
        subtype: spec.subtype,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
      };
      // matched-turn（派活失败 W6-5）：按 workItemId 对回 voiceDispatch 派活轮，
      // 对不上退当前轮，一个轮都没有就独立成轮——失败记录绝不丢，也不留在半空。
      // current-turn（通话摘要 §7.5 / 通话失败 T3-#908）：通话级事件，挂当前轮。
      const hostTurn = spec.attach === 'matched-turn'
        ? findVoiceWorkTurn(turns, (payload as { workItemId?: string }).workItemId) ?? currentTurn
        : currentTurn;
      if (hostTurn) {
        hostTurn.nodes.push(node);
        hostTurn.endTime = msg.timestamp;
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

    // Runtime supplements are part of the in-flight task, not a new turn.
    const runtimeInputMode = msg.metadata?.workbench?.runtimeInputMode;
    if (
      msg.role === 'user'
      && runtimeInputMode === 'supplement'
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
      // 语音字幕（X5.5-D2）：字幕是会话流，不是 turn 边界——通话中用户再开口落的
      // 一条 user 字幕，不许把装着在跑 run 的派活轮当场切成 completed（任务卡还在转，
      // 轮已判完结，尾部动作条挂出）。字幕本身照常开轮、照常渲染进消息流；
      // 普通（typed/dictation）用户消息仍是 turn 边界，关闭上一轮不变。
      const isVoiceSubtitle = msg.metadata?.source === 'voice';
      // Close previous turn
      if (currentTurn && !isVoiceSubtitle) {
        currentTurn.status = 'completed';
        if (currentTurn.nodes.length > 0) {
          currentTurn.endTime = currentTurn.nodes[currentTurn.nodes.length - 1].timestamp;
        }
      }

      turnCounter++;
      const neoSourceTurnId = msg.metadata?.neoTag?.sourceTurnId;
      currentTurn = {
        turnNumber: turnCounter,
        turnId: neoSourceTurnId || `turn-${turnCounter}`,
        nodes: [],
        status: 'completed',
        startTime: msg.timestamp,
      };
      turns.push(currentTurn);

      currentTurn.nodes.push({
        id: msg.id,
        // 语音派出的那条指令是通话 brain 改写的，不是用户原话（原话是字幕那条）。
        // 存的是 role:'user'（runtime 需要一条用户轮），但**不能顶着用户身份显示在右边**——
        // 那等于把机器编的话安在用户嘴里。投成左侧节点，由渲染层标明来源。
        type: msg.metadata?.voiceDispatch ? 'assistant_text' : 'user',
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
      // 运行失败的结构化错误挂在 metadata 上（AgentErrorCard），content 可能为空——
      // 不能按"空消息"跳过，否则错误卡片投不出来。
      const hasAgentError = Boolean(msg.metadata?.agentError);

      // Skip empty assistant messages
      if (!hasContent && !hasReasoning && !hasToolCalls && !hasAgentError) continue;

      const turn = currentTurn;

      // 一条 assistant 消息若因 content_parts 交错（text 穿插 tool_call）拆成多个
      // assistant_text 节点，思考只在这次模型回复里发生一次，只挂在第一个节点上，
      // 避免同一段 thinking 在多个折叠行里重复出现（P0 去噪：思考块过多问题的根因之一）。
      let reasoningAttachedForMessage = false;

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
        const attachReasoning = !reasoningAttachedForMessage;
        reasoningAttachedForMessage = true;
        turn.nodes.push({
          id: index && index > 1 ? `${msg.id}-text-${index}` : `${msg.id}-text`,
          messageId: msg.id,
          type: 'assistant_text',
          content,
          timestamp: msg.timestamp,
          reasoning: attachReasoning ? msg.reasoning : undefined,
          thinking: attachReasoning ? msg.thinking : undefined,
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

        // 错误卡片尾随在工具行之后：带 agentError 的消息即使 content_parts 全是工具
        // 调用，也要补一个空正文节点承载 AgentErrorCard，否则失败无任何可见落点。
        if (hasAgentError) {
          pushAssistantTextNode('');
        }

        // content_parts 是权威交错顺序。走到这里若仍 textIndex===0，说明 parts 里没有
        // 任何 text part：不能把内存里残留的 msg.content 当尾随正文追加到工具行之后——
        // 流式期模型先吐的 preamble（如"使用Write工具来创建文件"）被服务端精简成纯工具
        // 调用后，content 仍残留在内存（落库为空），尾随渲染会让它悬在工具行下方、刷新即
        // 消失。reasoning 已在循环前以「思考先于工具」的顺序放置，这里不再补任何节点。
        continue;
      }

      if (hasContent || hasReasoning || hasAgentError) {
        pushAssistantTextNode(msg.content);
      }

      for (const tc of msg.toolCalls ?? []) {
        pushToolCallNode(tc);
      }
    }
  }

  // C4 / 施工单二 B：pending 投影轻量问答卡；resolved 后保留紧凑历史（不卸载节点）
  const sessionLaunchRequests = launchRequests
    .filter((request) => request.sessionId === sessionId)
    .slice()
    .sort((a, b) => a.requestedAt - b.requestedAt);
  for (const launchRequest of sessionLaunchRequests) {
    const launchNode: TraceNode = {
      id: `swarm-launch-${launchRequest.id}`,
      type: 'swarm_launch_request',
      content: launchRequest.summary,
      timestamp: launchRequest.requestedAt,
      launchRequest,
    };

    if (currentTurn) {
      currentTurn.nodes.push(launchNode);
      currentTurn.endTime = Math.max(currentTurn.endTime ?? 0, launchRequest.requestedAt);
    } else {
      turnCounter++;
      currentTurn = {
        turnNumber: turnCounter,
        turnId: `turn-${turnCounter}`,
        nodes: [launchNode],
        status: 'completed',
        startTime: launchRequest.requestedAt,
        endTime: launchRequest.requestedAt,
      };
      turns.push(currentTurn);
    }
  }

  // Neo Tag 轻量化重设计（产品负责人拍板 2026-07-02）：@neo = 正常 agent 聊天体验，
  // 会话里不再投影独立的 neo_work_card 卡片。@neo 的运行本就是同会话的正常 agent turn，
  // 其回复已在对话流里；work card 记录仅供账号菜单「Neo 协同」topic 目录做历史视图。

  // X5.5-D5：语音派出的 run 刻意活得比通话久，挂断后 run 的收尾文本 timestamp
  // 晚于摘要卡的 endedAt——摘要卡因此不在消息流最后。展示层把摘要卡钉到所在轮
  // 末尾（不改落库时序），恒排在这通电话 episode 的内容之后。
  pinVoiceCallSummaryToEpisodeEnd(turns);

  // Direct-routed sidecar messages should not steal the active marker from
  // the in-flight task. Normal user turns can still be active while waiting
  // for the first assistant response.
  let activeTurnIndex = -1;
  if (isProcessing && turns.length > 0) {
    const latestTurn = turns[turns.length - 1];
    // 钉在轮尾的通话摘要卡不是活动内容（D5）——判断轮尾时跳过它，否则钉尾会把
    // 在跑的派活轮从 active 上顶下来（lastNode 变成 system，流式标记丢失）。
    const latestNode = lastNonVoiceSummaryNode(latestTurn);
    const directRoutingDelivery = latestNode?.metadata?.workbench?.directRoutingDelivery;
    const isDirectRoutedUserTurn =
      latestNode?.type === 'user' &&
      latestNode.metadata?.workbench?.routingMode === 'direct' &&
      (directRoutingDelivery?.deliveredTargetIds?.length || 0) > 0;

    const isVoiceSubtitleTail =
      latestNode?.type === 'user' && latestNode.metadata?.source === 'voice';
    // 语音字幕轮不抢 active（X5.5-D2）：字幕刚来、run 还在跑时，若让字幕轮拿走
    // active 标记，派活轮就会跌回 completed——和关轮豁免是同一件事的两个出口。
    // 跳过它，让下面的回扫继续找到真正在跑的那一轮。
    if (latestNode?.type === 'user' && !isDirectRoutedUserTurn && !isVoiceSubtitleTail) {
      latestTurn.status = 'streaming';
      activeTurnIndex = turns.length - 1;
    }

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (activeTurnIndex >= 0) break;
      const candidateTurn = turns[index];
      const lastNode = lastNonVoiceSummaryNode(candidateTurn);
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

  // 活动轮思考尾置：流式期间 reasoning 挂在首文本节点会让每次落账/流式增量都在
  // 轮首（工具卡上方）撑高布局，钉底滚动下表现为上方整块逐行上跳（2026-07-21
  // 真机视频闪烁根因）。活动轮把 reasoning 搬到轮尾 live 节点让增长贴住视口底边；
  // 轮完成后本段不再触发，历史布局回落「思考先于工具」。
  if (activeTurnIndex >= 0) {
    relocateActiveTurnReasoningToTail(turns[activeTurnIndex]);
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

/** 按 workItemId 倒查最近的 voiceDispatch 派活轮（matched-turn 挂轮策略专用）。 */
function findVoiceWorkTurn(turns: TraceTurn[], workItemId: string | undefined): TraceTurn | undefined {
  if (!workItemId) return undefined;
  return [...turns]
    .reverse()
    .find((turn) => turn.nodes.some((n) => n.metadata?.voiceDispatch?.workItemId === workItemId));
}

/**
 * 开发档判定：与 typedInvoke.shouldValidateResponse 同例——Vite dev build 为 true，
 * 单测/Node 环境兜底 NODE_ENV。生产档对未登记键维持现状静默跳过。
 */
function isDevBuild(): boolean {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env && typeof env.DEV === 'boolean') return env.DEV;
  return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
}

/**
 * 未登记哨兵（P0-2）：role:'system' 消息带了「事件性」metadata 键却没在登记表里，
 * 说明有人新写了用户可见事件却漏了登记——开发档立刻报错（契约测试同步报红），
 * 不再像 #908 那样静默丢到 11 个 PR 后才被真机撞见。生产档按现状跳过，不改线上行为。
 */
function reportUnregisteredSystemEventMetadata(msg: Message): void {
  if (!msg.metadata || !isDevBuild()) return;
  const keys = findUnregisteredSystemEventKeys(msg.metadata);
  if (keys.length === 0) return;
  console.error(
    `[useTurnProjection] role:'system' 消息带未登记的 metadata 键：${keys.join(', ')}（消息 ${msg.id}）。`
    + '若是用户可见事件，请在 shared/contract/systemEventRegistry 的 USER_VISIBLE_SYSTEM_EVENT_REGISTRY 登记；'
    + '若是内部投影，登记进 INTERNAL_SYSTEM_METADATA_KEYS。生产档按现状跳过。',
  );
}

/**
 * X5.5-D5：把「语音通话摘要」节点钉到所在轮的末尾。
 * 语音派出的 run 被刻意设计为活得比通话久，挂断后 run 的收尾文本 timestamp 晚于
 * 摘要卡的 endedAt，摘要卡因此不在这通 episode 的最后。这里只动展示层节点顺序，
 * 不改落库时序；摘要卡恒排在本轮这通电话的内容之后。钉钉是幂等的。
 */
function pinVoiceCallSummaryToEpisodeEnd(turns: TraceTurn[]): void {
  for (const turn of turns) {
    const summaryNodes = turn.nodes.filter((node) => node.subtype === 'voice_call_summary');
    if (summaryNodes.length === 0) continue;
    if (turn.nodes[turn.nodes.length - 1]?.subtype === 'voice_call_summary') continue;
    turn.nodes = turn.nodes
      .filter((node) => node.subtype !== 'voice_call_summary')
      .concat(summaryNodes);
  }
}

/** 轮尾的「真实内容节点」：跳过钉尾的通话摘要卡（D5），active/流式判断不看它。 */
function lastNonVoiceSummaryNode(turn: TraceTurn): TraceNode | undefined {
  for (let index = turn.nodes.length - 1; index >= 0; index -= 1) {
    const node = turn.nodes[index];
    if (node.subtype !== 'voice_call_summary') return node;
  }
  return undefined;
}

/** 本轮最后一条助手消息的 id —— 流式期间正在生长的那条。 */
function lastAssistantMessageIdInTurn(turn: TraceTurn): string | undefined {
  for (let index = turn.nodes.length - 1; index >= 0; index -= 1) {
    const node = turn.nodes[index];
    if (node.type === 'assistant_text' && node.messageId) return node.messageId;
  }
  return undefined;
}

function relocateActiveTurnReasoningToTail(turn: TraceTurn): void {
  const carrierIndex = turn.nodes.findIndex(
    (node) => node.type === 'assistant_text' && Boolean(node.reasoning || node.thinking),
  );
  if (carrierIndex < 0) return;
  const carrier = turn.nodes[carrierIndex];
  if (!carrier.messageId) return;
  // 只搬**正在生长**的那条消息的思考（2026-08-01 症状 2）。尾置的目的是让流式思考贴住
  // 视口底边、并与已落账的那半连成一块（PR #541）；已经写完的早期响应的思考不在生长，
  // 搬它不服务任何目的，却会让那一块随着本轮新内容不断往下滑——用户看到的「块顺序反复
  // 跳」有一大半是它。
  if (carrier.messageId !== lastAssistantMessageIdInTurn(turn)) return;
  const hasTrailingDisplayNodes = turn.nodes
    .slice(carrierIndex + 1)
    .some((node) => node.type === 'assistant_text' || node.type === 'tool_call');
  if (!hasTrailingDisplayNodes) return; // 本就在尾部，保持原状

  turn.nodes.push({
    id: getReasoningLiveNodeId(carrier.messageId),
    messageId: carrier.messageId,
    type: 'assistant_text',
    content: '',
    timestamp: carrier.timestamp,
    reasoning: carrier.reasoning,
    thinking: carrier.thinking,
  });
  const strippedCarrier = { ...carrier, reasoning: undefined, thinking: undefined };
  // 纯思考承载节点（空正文）被搬空后不留空壳
  if (strippedCarrier.content.trim().length === 0) {
    turn.nodes.splice(carrierIndex, 1);
  } else {
    turn.nodes[carrierIndex] = strippedCarrier;
  }
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
  neoWorkCards: NeoWorkCardDetail[] = [],
): TraceProjection {
  return useMemo(
    () => projectTurns(messages, sessionId, isProcessing, launchRequests, neoWorkCards),
    [messages, sessionId, isProcessing, launchRequests, neoWorkCards],
  );
}
