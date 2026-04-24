// ContextAssembly - Model message construction and transcript projection.
import type { Message } from '../../../../shared/contract';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { getContextWindow } from '../../../../shared/constants';
import type { ModelMessage } from '../../../agent/loopTypes';
import { formatToolCallForHistory, buildMultimodalContent } from '../../../agent/messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildRuntimeModeBlock,
} from '../../../agent/messageHandling/contextBuilder';
import { loadMemoryIndex } from '../../../lightMemory/indexLoader';
import { loadRelevantSkills, buildSkillInjectionBlock } from '../../../lightMemory/skillLoader';
import { getRepoMap } from '../../../context/repoMap';
import { buildSessionMetadataBlock } from '../../../lightMemory/sessionMetadata';
import { buildRecentConversationsBlock } from '../../../lightMemory/recentConversations';
import { getPromptForTask, needsGenerativeUI, GENERATIVE_UI_PROMPT } from '../../../prompts/builder';
import { buildActiveAgentContext, drainCompletionNotifications } from '../../../agent/activeAgentContext';
import { getDeferredToolsSummary } from '../../../protocol/dispatch/toolDefinitions';
import { estimateModelMessageTokens, estimateTokens } from '../../../context/tokenOptimizer';
import { compactModelSummarize } from '../../../context/compactModel';
import { CompressionState } from '../../../context/compressionState';
import { getContextInterventionState } from '../../../context/contextInterventionState';
import { applyInterventionsToMessages } from '../../../context/contextInterventionHelpers';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { getSystemPromptCache } from '../../../telemetry/systemPromptCache';
import { logCollector } from '../../../mcp/logCollector.js';
import { createHash } from 'crypto';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from '../contextAssembly';
import { logger, MAX_SYSTEM_PROMPT_TOKENS } from '../contextAssembly';

export async function buildModelMessages(ctx: ContextAssemblyCtx): Promise<ModelMessage[]> {
  ctx.flushHookMessageBuffer();

  const modelMessages: ModelMessage[] = [];
  const modelMessageSourceIds: string[] = [];

  // Use optimized prompt based on task complexity
  let systemPrompt = getPromptForTask();

  const genNum = 8;
  if (genNum >= 3 && !ctx.runtime.isSimpleTaskMode) {
    // Only enhance with RAG for non-simple tasks
    const lastUserMessage = [...ctx.runtime.messages].reverse().find((m: any) => m.role === 'user');
    const userQuery = lastUserMessage?.content || '';
    systemPrompt = await buildEnhancedSystemPrompt(systemPrompt, userQuery, ctx.runtime.isSimpleTaskMode);
  }

  systemPrompt = injectWorkingDirectoryContext(systemPrompt, ctx.runtime.workingDirectory, ctx.runtime.isDefaultWorkingDirectory);
  systemPrompt += buildRuntimeModeBlock();

  // 注入 Session Metadata（使用频率/行为模式，借鉴 ChatGPT Layer 2）
  const sessionMeta = await buildSessionMetadataBlock();
  if (sessionMeta) {
    systemPrompt += `\n\n${sessionMeta}`;
  }

  // 注入轻量记忆索引（File-as-Memory）
  // 默认只放短提示（~30 tok），实际索引按意图注入——检测到用户查询跟记忆/过往有关时才塞全量
  const memoryIndex = await loadMemoryIndex();
  if (memoryIndex) {
    const lastUserForMem = [...ctx.runtime.messages].reverse().find((m: any) => m.role === 'user');
    const userQueryForMem = (lastUserForMem?.content || '') as string;
    const memIntentPattern = /记忆|记得|回忆|之前|上次|上一次|历史|先前|previous|remember|recall|memory|before|earlier/i;
    if (typeof userQueryForMem === 'string' && memIntentPattern.test(userQueryForMem)) {
      // 用户查询涉及过往记忆，注入完整索引
      systemPrompt += `\n\n<memory_index>\n${memoryIndex}\n</memory_index>`;
      logger.debug('[ContextAssembly] memory_index injected (intent matched)');
    } else {
      // 日常对话：只放短提示，让模型知道可以用 MemoryRead 工具按需查
      systemPrompt += `\n\n<memory_hint>Memory files available via MemoryRead tool (see ~/.claude/memory/ and ~/.code-agent/memory/).</memory_hint>`;
    }
  }

  // 注入相关 Skill（Hermes Procedural layer）— 按用户查询关键词匹配
  // 命中 skill_*.md 文件并追加到 dynamic section
  if (!ctx.runtime.isSimpleTaskMode) {
    try {
      const lastUserMessage = [...ctx.runtime.messages]
        .reverse()
        .find((m: any) => m.role === 'user');
      const userQueryForSkills = lastUserMessage?.content || '';
      if (userQueryForSkills) {
        const skills = await loadRelevantSkills(userQueryForSkills);
        const skillBlock = buildSkillInjectionBlock(skills);
        if (skillBlock) {
          systemPrompt += `\n\n${skillBlock}`;
          logger.debug(
            `[ContextAssembly] Injected ${skills.length} relevant skill(s) into prompt`,
          );
        }
      }
    } catch (err) {
      logger.debug(
        `[ContextAssembly] Skill injection skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  // 注入 Repo Map（代码结构索引，借鉴 Aider）
  if (ctx.runtime.workingDirectory && !ctx.runtime.isSimpleTaskMode) {
    try {
      const repoMapResult = await getRepoMap({
        rootDir: ctx.runtime.workingDirectory,
        tokenBudget: 1500,
      });
      if (repoMapResult.text) {
        systemPrompt += `\n\n<repo_map>\n${repoMapResult.text}\n</repo_map>`;
        logger.debug(`[ContextAssembly] RepoMap injected: ${repoMapResult.fileCount} files, ${repoMapResult.symbolCount} symbols, ~${repoMapResult.estimatedTokens} tokens`);
      }
    } catch (err) {
      logger.debug(`[ContextAssembly] RepoMap skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 注入近期对话摘要（跨会话连续性，借鉴 ChatGPT Layer 4）
  const recentConvs = await buildRecentConversationsBlock();
  if (recentConvs) {
    systemPrompt += `\n\n${recentConvs}`;
  }

  // 按意图注入 Generative UI 能力说明（~700 tok）
  // 日常对话不需要这段，只有用户要画图/做表/生成 HTML 时才注入
  const lastUserMsgForGenUI = [...ctx.runtime.messages].reverse().find((m: any) => m.role === 'user');
  const userQueryForGenUI = lastUserMsgForGenUI?.content || '';
  if (typeof userQueryForGenUI === 'string' && needsGenerativeUI(userQueryForGenUI)) {
    systemPrompt += `\n\n${GENERATIVE_UI_PROMPT}`;
    logger.debug('[ContextAssembly] GenerativeUI prompt injected (intent matched)');
  }

  // 注入延迟工具提示
  if (ctx.runtime.enableToolDeferredLoading) {
    const deferredToolsSummary = getDeferredToolsSummary();
    if (deferredToolsSummary) {
      systemPrompt += `

<deferred-tools>
除了核心工具外，以下工具可通过 ToolSearch 发现和加载。当核心工具无法完成任务时（例如需要浏览器操作、截图、PPT/Excel 生成、图片分析等），你必须先用 ToolSearch 加载对应工具。

${deferredToolsSummary}

用法：ToolSearch("browser") 搜索浏览器工具 | ToolSearch("select:Browser") 直接加载
</deferred-tools>`;
    }
  }

  // 注入活跃子代理上下文（Phase 3: 让主 Agent 感知当前 team 状态）
  const activeAgentBlock = buildActiveAgentContext();
  if (activeAgentBlock) {
    systemPrompt += activeAgentBlock;
  }

  // 注入后台 agent 完成通知（Codex-style async notifications）
  const completionNotifications = drainCompletionNotifications();
  if (completionNotifications.length > 0) {
    systemPrompt += '\n\n' + completionNotifications.join('\n');
  }

  // 拼接持久化系统上下文（任务指导、模式 reminder 等）
  // 这些信息每轮推理都需要可见，而非作为消息历史被淹没
  const persistentSystemContext = ctx.getBudgetedPersistentSystemContext();
  if (persistentSystemContext.length > 0) {
    systemPrompt += '\n\n' + persistentSystemContext.join('\n\n');
  }

  // Check system prompt length and warn if too long
  const systemPromptTokens = estimateTokens(systemPrompt);
  if (systemPromptTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(`[AgentLoop] System prompt too long: ${systemPromptTokens} tokens (limit: ${MAX_SYSTEM_PROMPT_TOKENS})`);
    logCollector.agent('WARN', 'System prompt exceeds recommended limit', {
      tokens: systemPromptTokens,
      limit: MAX_SYSTEM_PROMPT_TOKENS,
    });
  }

  // Cache system prompt for eval center review + telemetry
  try {
    const hash = createHash('sha256').update(systemPrompt).digest('hex');
    ctx.runtime.currentSystemPromptHash = hash;
    getSystemPromptCache().store(hash, systemPrompt, systemPromptTokens, 'gen8');
  } catch {
    // Non-critical: don't break agent loop if cache fails
  }

  modelMessages.push({
    role: 'system',
    content: systemPrompt,
  });
  modelMessageSourceIds.push('__system_prompt__');

  const interventionState = getContextInterventionState();
  const effectiveInterventions = interventionState.getEffectiveSnapshot(ctx.runtime.sessionId, ctx.runtime.agentId);
  const transcriptEntries = ctx.buildContextTranscriptEntries(ctx.runtime.messages);
  const transcriptInterventions = ctx.mapInterventionsToTranscriptEntries(
    effectiveInterventions,
    transcriptEntries,
  );
  const excludedTranscriptIds = new Set(transcriptInterventions.excluded);
  const interventionAdjustedEntries = applyInterventionsToMessages(
    transcriptEntries.filter((entry) => !excludedTranscriptIds.has(entry.id)),
    transcriptInterventions,
    transcriptEntries,
  );

  let contextApiView = interventionAdjustedEntries;
  const contextWindowSize = getContextWindow(ctx.runtime.modelConfig.model);
  try {
    const nextCompressionState = new CompressionState();
    const lastActivityAt = interventionAdjustedEntries.at(-1)?.timestamp ?? Date.now();
    const idleMinutes = Math.max(0, (Date.now() - lastActivityAt) / 60_000);
    const currentTurnIndex = interventionAdjustedEntries.reduce(
      (maxTurnIndex, entry) => Math.max(maxTurnIndex, entry.turnIndex),
      0,
    );

    const pipelineResult = await ctx.runtime.compressionPipeline.evaluate(
      interventionAdjustedEntries.map((entry) => ({ ...entry })),
      nextCompressionState,
      {
        maxTokens: contextWindowSize,
        currentTurnIndex,
        isMainThread: !ctx.runtime.agentId,
        cacheHot: idleMinutes < 2,
        idleMinutes,
        summarize: (messages) => ctx.summarizeCollapsedContext(messages),
        enableSnip: true,
        enableMicrocompact: true,
        enableContextCollapse: true,
        toolResultBudget: 2000,
        interventions: transcriptInterventions,
      },
    );

    ctx.runtime.compressionState = nextCompressionState;
    contextApiView = pipelineResult.apiView as ContextTranscriptEntry[];
    const entryIdToOriginMessageId = new Map(
      interventionAdjustedEntries.map((entry) => [entry.id, entry.originMessageId]),
    );
    getContextEventLedger().upsertCompressionEvents(
      ctx.runtime.sessionId,
      ctx.runtime.agentId,
      nextCompressionState.getCommitLog(),
      (messageId) => entryIdToOriginMessageId.get(messageId) ?? messageId,
    );

    if (nextCompressionState.getCommitLog().length > 0) {
      logger.debug('[ContextAssembly] Compression pipeline applied', {
        layersTriggered: pipelineResult.layersTriggered,
        commitCount: nextCompressionState.getCommitLog().length,
        apiViewMessages: pipelineResult.apiView.length,
      });
    }
  } catch (error) {
    logger.error('[ContextAssembly] Compression pipeline evaluation failed, falling back to uncompressed transcript:', error);
    ctx.runtime.compressionState = new CompressionState();
  }

  logger.debug('[AgentLoop] Building model messages, total messages:', contextApiView.length);
  for (const entry of contextApiView) {
    logger.debug(` Message role=${entry.role}, hasAttachments=${!!entry.attachments?.length}, attachmentCount=${entry.attachments?.length || 0}`);

    if (entry.role === 'tool') {
      modelMessages.push({
        role: 'tool',
        content: entry.content,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(entry.toolError ? { toolError: true } : {}),
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else if (entry.role === 'assistant' && entry.toolCalls?.length) {
      // 过滤掉已废弃工具的历史调用，避免模型从上下文中误判这些工具仍可用
      const REMOVED_TOOLS = new Set(['TodoWrite', 'todo_write']);
      const tcs = entry.toolCalls.filter(tc => !REMOVED_TOOLS.has(tc.name));
      if (tcs.length === 0 && !entry.content) continue;
      modelMessages.push({
        role: 'assistant',
        content: entry.content || '',
        ...(tcs.length > 0 && {
          toolCalls: tcs.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          })),
          toolCallText: tcs.map(tc => formatToolCallForHistory(tc)).join('\n'),
        }),
        thinking: entry.thinking,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else if (entry.role === 'user' && entry.attachments?.length) {
      const multimodalContent = buildMultimodalContent(entry.content, entry.attachments);
      modelMessages.push({
        role: 'user',
        content: multimodalContent,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else {
      modelMessages.push({
        role: entry.role,
        content: entry.content,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    }
  }

  // Proactive compression check: trigger at 75% capacity to prevent hitting hard limits
  // 注意：maxTokens 是模型的最大输出限制，不是上下文窗口大小
  // 上下文窗口大小应该更大（如 64K-128K），这里使用保守估计 64000
  const currentTokens = estimateModelMessageTokens(modelMessages);
  if (ctx.runtime.messageHistoryCompressor.shouldProactivelyCompress(currentTokens, contextWindowSize)) {
    logger.info(`[AgentLoop] Proactive compression triggered: ${currentTokens}/${contextWindowSize} tokens (${Math.round(currentTokens / contextWindowSize * 100)}%)`);
    logCollector.agent('INFO', 'Proactive compression triggered', {
      currentTokens,
      maxTokens: contextWindowSize,
      usagePercent: Math.round(currentTokens / contextWindowSize * 100),
    });
  }

  return modelMessages;
}

export function buildContextTranscriptEntries(ctx: ContextAssemblyCtx, messages: Message[]): ContextTranscriptEntry[] {
  let turnIndex = 0;
  let hasSeenUserTurn = false;
  const entries: ContextTranscriptEntry[] = [];

  for (const message of messages) {
    if (message.role === 'user' && hasSeenUserTurn) {
      turnIndex += 1;
    }
    if (message.role === 'user') {
      hasSeenUserTurn = true;
    }

    const baseEntry = {
      originMessageId: message.id,
      timestamp: message.timestamp,
      turnIndex,
    };

    if (message.role === 'tool' && message.toolResults?.length) {
      entries.push(
        ...message.toolResults.map((result, index) => ({
          ...baseEntry,
          id: `${message.id}::tool-result::${result.toolCallId || index}`,
          role: 'tool',
          content: result.output || result.error || '',
          toolCallId: result.toolCallId,
          toolError: !result.success,
        })),
      );
      continue;
    }

    entries.push({
      ...baseEntry,
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
    });
  }

  return entries;
}

export function mapInterventionsToTranscriptEntries(
  ctx: ContextAssemblyCtx,
  interventions: ContextInterventionSnapshot,
  entries: ContextTranscriptEntry[],
): ContextInterventionSnapshot {
  const entryIdsByOriginMessageId = new Map<string, string[]>();
  for (const entry of entries) {
    const entryIds = entryIdsByOriginMessageId.get(entry.originMessageId) || [];
    entryIds.push(entry.id);
    entryIdsByOriginMessageId.set(entry.originMessageId, entryIds);
  }

  const expandIds = (ids: string[]): string[] => {
    const expanded = new Set<string>();
    for (const id of ids) {
      const mappedIds = entryIdsByOriginMessageId.get(id);
      if (mappedIds && mappedIds.length > 0) {
        for (const mappedId of mappedIds) {
          expanded.add(mappedId);
        }
      } else {
        expanded.add(id);
      }
    }
    return Array.from(expanded);
  };

  return {
    pinned: expandIds(interventions.pinned),
    excluded: expandIds(interventions.excluded),
    retained: expandIds(interventions.retained),
  };
}

export async function summarizeCollapsedContext(
  ctx: ContextAssemblyCtx,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const prompt = [
    '请将下面这段运行上下文压缩成一段简洁摘要。',
    '要求：保留关键结论、文件路径、工具结果、失败原因和后续待办；不要编造；尽量控制在 200 tokens 内。',
    '',
    '上下文片段：',
    ...messages.map((message) => `[${message.role}] ${message.content}`),
  ].join('\n');

  try {
    return (await compactModelSummarize(prompt, 200)).trim();
  } catch (error) {
    logger.warn('[ContextAssembly] Context collapse summarization failed, using heuristic fallback', error);
    return messages
      .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
      .join(' | ')
      .slice(0, 1000);
  }
}

export function stripInternalFormatMimicry(ctx: ContextAssemblyCtx, content: string): string {
  if (!content) return content;
  let cleaned = content;
  // Remove "Ran: <command>" lines (model mimicking formatToolCallForHistory output)
  cleaned = cleaned.replace(/^Ran:\s+.+$/gm, '');
  // Remove "Tool results:" lines
  cleaned = cleaned.replace(/^Tool results:\s*$/gm, '');
  // Remove "[Compressed tool results: ...]" lines
  cleaned = cleaned.replace(/^\[Compressed tool results:.*?\]\s*$/gm, '');
  // Remove "<checkpoint-nudge ...>...</checkpoint-nudge>" blocks
  cleaned = cleaned.replace(/<checkpoint-nudge[^>]*>[\s\S]*?<\/checkpoint-nudge>/g, '');
  // Remove "<truncation-recovery>...</truncation-recovery>" blocks
  cleaned = cleaned.replace(/<truncation-recovery>[\s\S]*?<\/truncation-recovery>/g, '');
  // Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

export function detectTaskPatterns(ctx: ContextAssemblyCtx, userMessage: string): string[] {
  const hints: string[] = [];
  const msg = userMessage.toLowerCase();

  // 异常检测任务 — 防止输出全部行
  if (/异常|anomal|outlier|离群/i.test(userMessage)) {
    hints.push(
      '【异常检测】输出文件只包含被标记为异常的行，不要输出全部数据。' +
      '使用 IQR 或 Z-score 方法检测，异常标记列用数值 0/1 或布尔值（不要用中文"是"/"否"字符串）。'
    );
  }

  // 透视表 + 交叉分析 — 防止遗漏子任务
  if (/透视|pivot|交叉分析/i.test(userMessage)) {
    hints.push(
      '【透视分析】此类任务通常包含多个子任务，务必逐项完成：' +
      '① 透视表 ② 排名/Top N ③ 增长率计算 ④ 图表 ⑤ 品类/分类占比数据。' +
      '每个子任务的结果保存为独立的 sheet 或文件。完成后对照检查是否有遗漏。'
    );
  }

  // 多轮迭代任务 — 防止上下文丢失
  if (ctx.runtime.messages.length > 10) {
    // This is a continuation turn in a multi-round session
    hints.push(
      '【多轮任务】这是多轮迭代任务。请先用 bash ls 检查输出目录中已有的文件，' +
      '在已有文件基础上修改，不要从头重建。图表修改请先读取数据源再重新生成。'
    );
  }

  return hints;
}

export function getCurrentAttachments(ctx: ContextAssemblyCtx): Array<{
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}> {
  for (let i = ctx.runtime.messages.length - 1; i >= 0; i--) {
    const msg = ctx.runtime.messages[i];
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      return msg.attachments.map(att => ({
        type: att.type,
        category: att.category,
        name: att.name,
        path: att.path,
        data: att.data,
        mimeType: att.mimeType,
      }));
    }
  }
  return [];
}
