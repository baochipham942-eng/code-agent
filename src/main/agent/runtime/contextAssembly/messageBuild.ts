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
import {
  getPromptForTask,
  needsGenerativeUI,
  GENERATIVE_UI_PROMPT,
  QUESTION_FORM_PROMPT,
  ARTIFACT_TASK_BRIEF_PROMPT,
  needsArtifactTaskBrief,
} from '../../../prompts/builder';
import { getTrustedRemotePromptFragmentsRevision } from '../../../prompts/remoteFragments';
import { HANDOFF_PROPOSAL_PROMPT } from '../../../prompts/handoff';
import {
  GAME_ARTIFACT_CONTRACT_PROMPT,
  GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT,
  needsGameArtifactContract,
} from '../../../prompts/artifactGeneration';
import { buildActiveAgentContext, drainCompletionNotifications } from '../../../agent/activeAgentContext';
import { getDeferredToolsSummary } from '../../../tools/dispatch/toolDefinitions';
import { estimateModelMessageTokens, estimateTokens } from '../../../context/tokenOptimizer';
import { CompressionState } from '../../../context/compressionState';
import { getContextInterventionState } from '../../../context/contextInterventionState';
import { applyInterventionsToMessages } from '../../../context/contextInterventionHelpers';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { getSystemPromptCache } from '../../../telemetry/systemPromptCache';
import { logCollector } from '../../../mcp/logCollector.js';
import { countTraceEntries, recordMemoryInjectionTrace } from '../../../memory/memoryInjectionTrace';
import { createHash } from 'crypto';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from '../contextAssembly';
import { logger, MAX_SYSTEM_PROMPT_TOKENS } from '../contextAssembly';
import { persistRuntimeState } from '../runtimeStatePersistence';
import { getPluginRegistry } from '../../../plugins/pluginRegistry';
import {
  buildArtifactRepairFocusBlock,
  getAllowedArtifactRepairToolCallIds,
  getArtifactRepairContext,
  getArtifactRepairHistoryToolAllowlist,
  hasGameArtifactRepairSignals,
  isArtifactRepairMode,
} from './artifactRepairProjection';

export { formatArtifactRepairToolResultContent } from './artifactRepairProjection';
export {
  buildContextTranscriptEntries,
  detectTaskPatterns,
  getCurrentAttachments,
  mapInterventionsToTranscriptEntries,
  stripInternalFormatMimicry,
  summarizeCollapsedContext,
} from './transcriptProjection';

const DYNAMIC_PROMPT_CACHE_TTL_MS = 2 * 60 * 1000;
const COMPRESSION_CACHE_TTL_MS = 30 * 1000;

const MEMORY_INTENT_PATTERN = /记忆|记得|回忆|之前|上次|上一次|历史|先前|previous|remember|recall|memory|before|earlier/i;
const RECENT_CONVERSATIONS_INTENT_PATTERN = /继续|接着|上次|上一轮|之前|历史|recent|previous|continue|resume|earlier/i;
const REPO_MAP_INTENT_PATTERN = /代码|仓库|文件|实现|测试|修复|报错|构建|重构|性能|源码|模块|函数|类|bug|repo|code|file|test|fix|implement|refactor|build|performance|source|module/i;
type RuntimeAssemblyCache = {
  dynamicPrompt?: {
    key: string;
    createdAt: number;
    prompt: string;
    tokens: number;
  };
  compression?: {
    key: string;
    createdAt: number;
    apiView: ContextTranscriptEntry[];
    state: string;
  };
};

type PromptAppendPolicy =
  | { kind: 'optional' }
  | { kind: 'required'; trimCandidates?: string[] };

const runtimeAssemblyCaches = new WeakMap<object, RuntimeAssemblyCache>();

function getRuntimeAssemblyCache(ctx: ContextAssemblyCtx): RuntimeAssemblyCache {
  let cache = runtimeAssemblyCaches.get(ctx.runtime as unknown as object);
  if (!cache) {
    cache = {};
    runtimeAssemblyCaches.set(ctx.runtime as unknown as object, cache);
  }
  return cache;
}

function getLastUserMessage(ctx: ContextAssemblyCtx): Message | undefined {
  return [...ctx.runtime.messages].reverse().find((message) => message.role === 'user');
}

function buildDynamicPromptCacheKey(ctx: ContextAssemblyCtx, userQuery: string, artifactRepairMode: boolean): string {
  return [
    ctx.runtime.sessionId,
    ctx.runtime.agentId || '',
    ctx.runtime.workingDirectory || '',
    String(ctx.runtime.isDefaultWorkingDirectory),
    String(ctx.runtime.isSimpleTaskMode),
    String(ctx.runtime.enableToolDeferredLoading),
    ctx.runtime.modelConfig.model || '',
    getLastUserMessage(ctx)?.id || '',
    ctx.runtime.activeSkillInvocation?.skillName || '',
    ctx.runtime.activeSkillContextBlock ? 'active-skill' : '',
    artifactRepairMode ? 'artifact-repair' : 'normal',
    String(getTrustedRemotePromptFragmentsRevision()),
    userQuery,
  ].join('\u0000');
}

function appendPromptBlockWithinBudget(
  prompt: string,
  block: string | null | undefined,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (!block) return prompt;
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(`[ContextAssembly] Skipping ${label}: system prompt budget would be ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`);
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算跳过 ${label}：预计 ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
    return prompt;
  }
  return nextPrompt;
}

function appendRequiredPromptBlock(
  prompt: string,
  block: string,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(
      `[ContextAssembly] Preserving required ${label}: system prompt budget is ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算保留必需 ${label}：预计 ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
  }
  return nextPrompt;
}

function removePromptBlock(prompt: string, block: string | null | undefined): string {
  if (!block) return prompt;
  const escapedBlock = block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prompt
    .replace(new RegExp(`\\n\\n${escapedBlock}`), '')
    .replace(new RegExp(`^${escapedBlock}\\n\\n`), '')
    .replace(new RegExp(`^${escapedBlock}$`), '');
}

function trimPreambleBeforeRequiredArtifactBlock(
  prompt: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (estimateTokens(prompt) <= MAX_SYSTEM_PROMPT_TOKENS) return prompt;

  const markerMatch = /\n\n## Game Artifact (?:Repair )?Contract\b/.exec(prompt);
  if (!markerMatch || typeof markerMatch.index !== 'number' || markerMatch.index <= 0) return prompt;

  const suffix = prompt.slice(markerMatch.index);
  let prefix = prompt.slice(0, markerMatch.index);
  const trimNotice = '\n[base prompt trimmed to preserve required artifact contract]\n';

  while (prefix.length > 0 && estimateTokens(`${prefix}${trimNotice}${suffix}`) > MAX_SYSTEM_PROMPT_TOKENS) {
    const overflow = estimateTokens(`${prefix}${trimNotice}${suffix}`) - MAX_SYSTEM_PROMPT_TOKENS;
    const removeChars = Math.max(240, overflow * 5);
    prefix = prefix.slice(0, Math.max(0, prefix.length - removeChars)).trimEnd();
  }

  const trimmedPrompt = `${prefix}${trimNotice}${suffix}`;
  if (estimateTokens(trimmedPrompt) <= MAX_SYSTEM_PROMPT_TOKENS) {
    ctx?.runtime.pendingRuntimeDiagnostics.push('上下文预算压缩 base prompt：保留必需 game artifact contract');
    return trimmedPrompt;
  }

  return prompt;
}

function appendPromptBlockWithinBudgetWithStatus(
  prompt: string,
  block: string | null | undefined,
  label: string,
  appendedBlocks: Map<string, string>,
  ctx?: ContextAssemblyCtx,
  policy: PromptAppendPolicy = { kind: 'optional' },
): { prompt: string; appended: boolean; trimmed?: string[] } {
  if (!block) {
    return { prompt, appended: false, trimmed: [] };
  }
  const nextPrompt = appendPromptBlockWithinBudget(prompt, block, label, ctx);
  if (nextPrompt !== prompt) {
    return { prompt: nextPrompt, appended: true, trimmed: [] };
  }
  if (policy.kind !== 'required') {
    return { prompt, appended: false, trimmed: [] };
  }

  const trimmed: string[] = [];
  let workingPrompt = prompt;
  for (const candidate of policy.trimCandidates ?? []) {
    const candidateBlock = appendedBlocks.get(candidate);
    if (!candidateBlock) continue;
    const nextCandidatePrompt = removePromptBlock(workingPrompt, candidateBlock);
    if (nextCandidatePrompt === workingPrompt) continue;
    workingPrompt = nextCandidatePrompt;
    appendedBlocks.delete(candidate);
    trimmed.push(candidate);
    const retriedPrompt = appendPromptBlockWithinBudget(workingPrompt, block, label, ctx);
    if (retriedPrompt !== workingPrompt) {
      return { prompt: retriedPrompt, appended: true, trimmed };
    }
  }

  return {
    prompt: appendRequiredPromptBlock(workingPrompt, block, label, ctx),
    appended: true,
    trimmed,
  };
}

const REQUIRED_REPAIR_TRIM_CANDIDATES = [
  'repo map',
  'skills',
  'recent conversations',
  'deferred tools',
  'generative UI',
  'question form',
  'handoff proposal',
  'active agent context',
  'completion notifications',
];

async function buildCachedDynamicSystemPrompt(ctx: ContextAssemblyCtx): Promise<string> {
  const lastUserMessage = getLastUserMessage(ctx);
  const userQuery = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
  const artifactRepairMode = isArtifactRepairMode(ctx);
  const cacheKey = buildDynamicPromptCacheKey(ctx, userQuery, artifactRepairMode);
  const cache = getRuntimeAssemblyCache(ctx);
  const cached = cache.dynamicPrompt;
  const now = Date.now();

  if (cached?.key === cacheKey && now - cached.createdAt < DYNAMIC_PROMPT_CACHE_TTL_MS) {
    logger.debug('[ContextAssembly] dynamic system prompt cache hit', { tokens: cached.tokens });
    return cached.prompt;
  }

  // Use optimized prompt based on task complexity
  let systemPrompt = getPromptForTask();
  const appendedBlocks = new Map<string, string>();
  const shouldInjectArtifactBrief = artifactRepairMode || (typeof userQuery === 'string' && needsArtifactTaskBrief(userQuery));
  const shouldInjectGameContract =
    (typeof userQuery === 'string' && needsGameArtifactContract(userQuery))
    || hasGameArtifactRepairSignals(ctx, userQuery);
  const shouldInjectGenerativeUI = typeof userQuery === 'string' && needsGenerativeUI(userQuery);

  if (shouldInjectArtifactBrief) {
    const artifactPromptBlock = shouldInjectGameContract
      ? artifactRepairMode
        ? GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT
        : GAME_ARTIFACT_CONTRACT_PROMPT
      : ARTIFACT_TASK_BRIEF_PROMPT;
    const artifactPromptLabel = shouldInjectGameContract
      ? artifactRepairMode
        ? 'game artifact repair contract'
        : 'game artifact contract'
      : 'artifact task brief';
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      artifactPromptBlock,
      artifactPromptLabel,
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: ['repo map', 'skills', 'recent conversations', 'deferred tools'] },
    );
    systemPrompt = result.prompt;
    if (result.appended) {
      appendedBlocks.set(artifactPromptLabel, artifactPromptBlock);
      logger.debug(
        `[ContextAssembly] ${artifactPromptLabel} prompt injected (${artifactRepairMode ? 'repair mode' : 'intent matched'})`,
      );
      if (result.trimmed?.length) {
        logger.warn(`[ContextAssembly] Trimmed prompt blocks to preserve ${artifactPromptLabel}: ${result.trimmed.join(', ')}`);
      }
    }
  }

  if (ctx.runtime.activeSkillContextBlock) {
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      ctx.runtime.activeSkillContextBlock,
      `active skill ${ctx.runtime.activeSkillInvocation?.skillName || ''}`.trim(),
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: ['repo map', 'skills', 'recent conversations', 'deferred tools', 'generative UI', 'question form'] },
    );
    systemPrompt = result.prompt;
    if (result.appended) {
      appendedBlocks.set('active skill', ctx.runtime.activeSkillContextBlock);
      logger.debug('[ContextAssembly] Active skill invocation prompt injected', {
        skillName: ctx.runtime.activeSkillInvocation?.skillName,
        matchKind: ctx.runtime.activeSkillInvocation?.matchKind,
      });
    }
  }

  const genNum = 8;
  if (genNum >= 3 && !ctx.runtime.isSimpleTaskMode) {
    // Only enhance with RAG for non-simple tasks
    systemPrompt = await buildEnhancedSystemPrompt(systemPrompt, userQuery, ctx.runtime.isSimpleTaskMode);
  }

  systemPrompt = injectWorkingDirectoryContext(systemPrompt, ctx.runtime.workingDirectory, ctx.runtime.isDefaultWorkingDirectory);
  systemPrompt += buildRuntimeModeBlock();

  if (!artifactRepairMode && !shouldInjectArtifactBrief) {
    const beforeHandoff = systemPrompt;
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      HANDOFF_PROPOSAL_PROMPT,
      'handoff proposal',
      ctx,
    );
    if (systemPrompt !== beforeHandoff) {
      appendedBlocks.set('handoff proposal', HANDOFF_PROPOSAL_PROMPT);
    }
  }

  // 注入 Session Metadata（使用频率/行为模式，借鉴 ChatGPT Layer 2）
  if (!artifactRepairMode && !shouldInjectArtifactBrief) {
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      await buildSessionMetadataBlock(),
      'session metadata',
      ctx,
    );
  }

  // 注入轻量记忆索引（File-as-Memory）
  // 先做意图判断，避免每轮无条件读 INDEX.md。
  if (!artifactRepairMode && !shouldInjectArtifactBrief && typeof userQuery === 'string' && MEMORY_INTENT_PATTERN.test(userQuery)) {
    const memoryIndex = await loadMemoryIndex();
    if (memoryIndex) {
      const memoryIndexBlock = `<memory_index>\n${memoryIndex}\n</memory_index>`;
      const beforeMemoryIndex = systemPrompt;
      systemPrompt = appendPromptBlockWithinBudget(
        systemPrompt,
        memoryIndexBlock,
        'memory index',
        ctx,
      );
      recordMemoryInjectionTrace({
        blockType: 'memory_index',
        trigger: 'memory_intent',
        chars: memoryIndex.length,
        injected: systemPrompt !== beforeMemoryIndex,
        source: 'light-memory-index',
        count: countTraceEntries(memoryIndex),
        sessionId: ctx.runtime.sessionId,
      });
      logger.debug('[ContextAssembly] memory_index injected (intent matched)');
    } else {
      recordMemoryInjectionTrace({
        blockType: 'memory_index',
        trigger: 'memory_intent_empty',
        chars: 0,
        injected: false,
        source: 'light-memory-index',
        count: 0,
        sessionId: ctx.runtime.sessionId,
      });
    }
  } else if (!artifactRepairMode && !shouldInjectArtifactBrief) {
    // 日常对话：只放短提示，让模型知道可以用 MemoryRead 工具按需查，不读取索引文件。
    const memoryHintBlock = '<memory_hint>Memory files available via MemoryRead tool (see ~/.code-agent/memory/).</memory_hint>';
    const beforeMemoryHint = systemPrompt;
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      memoryHintBlock,
      'memory hint',
      ctx,
    );
    recordMemoryInjectionTrace({
      blockType: 'memory_hint',
      trigger: 'default_memory_hint',
      chars: memoryHintBlock.length,
      injected: systemPrompt !== beforeMemoryHint,
      source: 'light-memory-tool-hint',
      count: 1,
      sessionId: ctx.runtime.sessionId,
    });
  }

  // 注入 active plugin 能力清单（Step 7 PR 2，让模型按语义自主识别能力缺口）
  try {
    const activePlugins = getPluginRegistry()
      .getPlugins()
      .filter((p) => p.state === 'active' && p.manifest.description);
    if (activePlugins.length > 0) {
      const lines = activePlugins.map((p) => {
        const desc = (p.manifest.description ?? '').slice(0, 60);
        const caps = p.manifest.capabilities?.length
          ? ` [${p.manifest.capabilities.join(', ')}]`
          : '';
        return `- ${p.manifest.id}: ${desc}${caps}`;
      });
      const pluginBlock = `<available_plugins>\n${lines.join('\n')}\n</available_plugins>`;
      systemPrompt = appendPromptBlockWithinBudget(systemPrompt, pluginBlock, 'available plugins', ctx);
    }
  } catch (err) {
    logger.debug(
      `[ContextAssembly] plugin description injection skipped: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  // 注入相关 Skill（Hermes Procedural layer）— 按用户查询关键词匹配。
  // P3.5 change: artifact-brief turns (Round 0 generation) now ALSO get skill
  // injection. Empirically Round 0 is where models miss the most concrete
  // implementation patterns (step()/runSmokeTest wiring); a domain-specific
  // skill in ~/.code-agent/memory/skill_*.md is far cheaper to maintain than
  // bloating the global game contract prompt. Repair turns (artifactRepairMode)
  // still skip skill injection — they already get the contract + reference
  // impl block, and adding skills on top would push past the 6K system budget.
  //
  // Provider-aware skip: mimo (xiaomi) is reasoning-heavy and its content
  // output collapses when the system prompt grows past ~10K. GPT-5.4 and
  // similar handle long prompts fine. Until skill content can be shortened
  // for the reasoning-heavy track, mimo opts out and falls back to the
  // contract-only prompt (which it tolerates well — see the A'+B' baseline).
  const provider = ctx.runtime.modelConfig?.provider;
  const skipSkillsForLongPromptIntolerantProvider = provider === 'xiaomi';
  if (
    !artifactRepairMode
    && !ctx.runtime.isSimpleTaskMode
    && userQuery
    && !skipSkillsForLongPromptIntolerantProvider
  ) {
    try {
      const skills = await loadRelevantSkills(userQuery);
      const skillBlock = buildSkillInjectionBlock(skills);
      if (skillBlock) {
        systemPrompt = appendPromptBlockWithinBudget(systemPrompt, skillBlock, 'skills', ctx);
        if (systemPrompt.includes(skillBlock)) {
          appendedBlocks.set('skills', skillBlock);
        }
        logger.debug(
          `[ContextAssembly] Injected ${skills.length} relevant skill(s) into prompt`,
        );
      }
    } catch (err) {
      logger.debug(
        `[ContextAssembly] Skill injection skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  // 注入 Repo Map（代码结构索引，借鉴 Aider）
  if (
    ctx.runtime.workingDirectory &&
    !ctx.runtime.isSimpleTaskMode &&
    REPO_MAP_INTENT_PATTERN.test(userQuery) &&
    !shouldInjectArtifactBrief &&
    !artifactRepairMode
  ) {
    try {
      const repoMapResult = await getRepoMap({
        rootDir: ctx.runtime.workingDirectory,
        tokenBudget: 1500,
      });
      if (repoMapResult.text) {
        const before = systemPrompt;
        systemPrompt = appendPromptBlockWithinBudget(
          systemPrompt,
          `<repo_map>\n${repoMapResult.text}\n</repo_map>`,
          'repo map',
          ctx,
        );
        if (systemPrompt !== before) {
          appendedBlocks.set('repo map', `<repo_map>\n${repoMapResult.text}\n</repo_map>`);
          logger.debug(`[ContextAssembly] RepoMap injected: ${repoMapResult.fileCount} files, ${repoMapResult.symbolCount} symbols, ~${repoMapResult.estimatedTokens} tokens`);
        }
      }
    } catch (err) {
      logger.debug(`[ContextAssembly] RepoMap skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 注入近期对话摘要（跨会话连续性，借鉴 ChatGPT Layer 4）
  if (!artifactRepairMode && !shouldInjectArtifactBrief && RECENT_CONVERSATIONS_INTENT_PATTERN.test(userQuery)) {
    const recentConversationsBlock = await buildRecentConversationsBlock();
    const beforeRecentConversations = systemPrompt;
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      recentConversationsBlock,
      'recent conversations',
      ctx,
    );
    recordMemoryInjectionTrace({
      blockType: 'recent_conversations',
      trigger: 'recent_conversations_intent',
      chars: recentConversationsBlock?.length ?? 0,
      injected: Boolean(recentConversationsBlock) && systemPrompt !== beforeRecentConversations,
      source: 'recent-conversations',
      count: countTraceEntries(recentConversationsBlock),
      sessionId: ctx.runtime.sessionId,
    });
    if (recentConversationsBlock && systemPrompt.includes(recentConversationsBlock)) {
      appendedBlocks.set('recent conversations', recentConversationsBlock);
    }
  }

  // 按意图注入 Generative UI 能力说明（~700 tok）+ Design brief 收集规则（~250 tok）
  if (shouldInjectGenerativeUI && !shouldInjectArtifactBrief) {
    systemPrompt = appendPromptBlockWithinBudget(systemPrompt, GENERATIVE_UI_PROMPT, 'generative UI', ctx);
    if (systemPrompt.includes(GENERATIVE_UI_PROMPT)) {
      appendedBlocks.set('generative UI', GENERATIVE_UI_PROMPT);
    }
    // 同条件注入 question-form 规则——LLM 看到 design-brief reminder 时会按规则跳过 form。
    systemPrompt = appendPromptBlockWithinBudget(systemPrompt, QUESTION_FORM_PROMPT, 'question form', ctx);
    if (systemPrompt.includes(QUESTION_FORM_PROMPT)) {
      appendedBlocks.set('question form', QUESTION_FORM_PROMPT);
    }
    logger.debug('[ContextAssembly] GenerativeUI + QuestionForm prompts injected (intent matched)');
  }

  // 注入延迟工具提示
  if (!artifactRepairMode && !shouldInjectArtifactBrief && ctx.runtime.enableToolDeferredLoading) {
    const deferredToolsSummary = getDeferredToolsSummary();
    if (deferredToolsSummary) {
      const deferredToolsBlock = `<deferred-tools>
除了核心工具外，以下工具可通过 ToolSearch 发现和加载。当核心工具无法完成任务时（例如需要浏览器操作、截图、PPT/Excel 生成、图片分析等），你必须先用 ToolSearch 加载对应工具。

${deferredToolsSummary}

用法：ToolSearch("browser") 搜索浏览器工具 | ToolSearch("select:Browser") 直接加载
</deferred-tools>`;
      systemPrompt = appendPromptBlockWithinBudget(
        systemPrompt,
        deferredToolsBlock,
        'deferred tools',
        ctx,
      );
      if (systemPrompt.includes(deferredToolsBlock)) {
        appendedBlocks.set('deferred tools', deferredToolsBlock);
      }
    }
  }

  const tokens = estimateTokens(systemPrompt);
  if (tokens <= MAX_SYSTEM_PROMPT_TOKENS) {
    cache.dynamicPrompt = {
      key: cacheKey,
      createdAt: now,
      prompt: systemPrompt,
      tokens,
    };
  } else {
    cache.dynamicPrompt = undefined;
  }

  return systemPrompt;
}

function buildCompressionCacheKey(
  ctx: ContextAssemblyCtx,
  entries: ContextTranscriptEntry[],
  interventions: ContextInterventionSnapshot,
  contextWindowSize: number,
): string {
  const hash = createHash('sha256');
  hash.update(ctx.runtime.sessionId);
  hash.update('\u0000');
  hash.update(ctx.runtime.agentId || '');
  hash.update('\u0000');
  hash.update(String(contextWindowSize));
  hash.update('\u0000');
  hash.update(JSON.stringify(interventions));
  for (const entry of entries) {
    hash.update('\u0000');
    hash.update(entry.id);
    hash.update('\u0001');
    hash.update(entry.originMessageId);
    hash.update('\u0001');
    hash.update(entry.role);
    hash.update('\u0001');
    hash.update(String(entry.timestamp));
    hash.update('\u0001');
    hash.update(entry.content || '');
    hash.update('\u0001');
    hash.update(entry.toolCallId || '');
    hash.update('\u0001');
    hash.update(String(entry.toolError || false));
    if (entry.attachments?.length) {
      hash.update(JSON.stringify(entry.attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        dataLength: attachment.data?.length || 0,
      }))));
    }
    if (entry.toolCalls?.length) {
      hash.update(JSON.stringify(entry.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || {},
      }))));
    }
  }
  return hash.digest('hex');
}

function cloneTranscriptEntries(entries: ContextTranscriptEntry[]): ContextTranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function cloneCompressionState(state: CompressionState): CompressionState {
  try {
    return CompressionState.deserialize(state.serialize());
  } catch {
    return new CompressionState();
  }
}

export async function buildModelMessages(ctx: ContextAssemblyCtx): Promise<ModelMessage[]> {
  ctx.flushHookMessageBuffer();

  const modelMessages: ModelMessage[] = [];
  const modelMessageSourceIds: string[] = [];

  let systemPrompt = await buildCachedDynamicSystemPrompt(ctx);
  const appendedBlocks = new Map<string, string>();

  // 注入活跃子代理上下文（Phase 3: 让主 Agent 感知当前 team 状态）
  const activeAgentBlock = buildActiveAgentContext();
  if (activeAgentBlock) {
    const nextPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      activeAgentBlock,
      'active agent context',
      ctx,
    );
    if (nextPrompt !== systemPrompt) {
      appendedBlocks.set('active agent context', activeAgentBlock);
      systemPrompt = nextPrompt;
    }
  }

  // 注入后台 agent 完成通知（Codex-style async notifications）
  const completionNotifications = drainCompletionNotifications();
  if (completionNotifications.length > 0) {
    const completionBlock = completionNotifications.join('\n');
    const nextPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      completionBlock,
      'completion notifications',
      ctx,
    );
    if (nextPrompt !== systemPrompt) {
      appendedBlocks.set('completion notifications', completionBlock);
      systemPrompt = nextPrompt;
    }
  }

  // 拼接持久化系统上下文（任务指导、模式 reminder 等）
  // 这些信息每轮推理都需要可见，而非作为消息历史被淹没
  const persistentSystemContext = ctx.getBudgetedPersistentSystemContext();
  const artifactRepairContext = getArtifactRepairContext(ctx);
  const artifactRepairContextSet = new Set(artifactRepairContext);
  for (let index = 0; index < persistentSystemContext.length; index += 1) {
    const contextBlock = persistentSystemContext[index];
    const repairContext = artifactRepairContextSet.has(contextBlock);
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      contextBlock,
      `persistent system context #${index + 1}`,
      appendedBlocks,
      ctx,
      repairContext
        ? { kind: 'required', trimCandidates: REQUIRED_REPAIR_TRIM_CANDIDATES }
        : { kind: 'optional' },
    );
    systemPrompt = result.prompt;
  }

  const artifactRepairFocusBlock = buildArtifactRepairFocusBlock(ctx, artifactRepairContext);
  if (artifactRepairFocusBlock) {
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      artifactRepairFocusBlock,
      'artifact repair focus',
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: REQUIRED_REPAIR_TRIM_CANDIDATES },
    );
    systemPrompt = result.prompt;
  }

  // Check system prompt length and warn if too long
  systemPrompt = trimPreambleBeforeRequiredArtifactBlock(systemPrompt, ctx);
  const trimmedSystemPromptTokens = estimateTokens(systemPrompt);
  if (trimmedSystemPromptTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(`[AgentLoop] System prompt too long: ${trimmedSystemPromptTokens} tokens (limit: ${MAX_SYSTEM_PROMPT_TOKENS})`);
    logCollector.agent('WARN', 'System prompt exceeds recommended limit', {
      tokens: trimmedSystemPromptTokens,
      limit: MAX_SYSTEM_PROMPT_TOKENS,
    });
  }

  // Cache system prompt for eval center review + telemetry
  try {
    const hash = createHash('sha256').update(systemPrompt).digest('hex');
    ctx.runtime.currentSystemPromptHash = hash;
    getSystemPromptCache().store(hash, systemPrompt, trimmedSystemPromptTokens, 'gen8');
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
    const cache = getRuntimeAssemblyCache(ctx);
    const compressionCacheKey = buildCompressionCacheKey(
      ctx,
      interventionAdjustedEntries,
      transcriptInterventions,
      contextWindowSize,
    );
    const cachedCompression = cache.compression;
    const now = Date.now();

    if (
      cachedCompression?.key === compressionCacheKey &&
      now - cachedCompression.createdAt < COMPRESSION_CACHE_TTL_MS
    ) {
      ctx.runtime.compressionState = CompressionState.deserialize(cachedCompression.state);
      persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
      contextApiView = cloneTranscriptEntries(cachedCompression.apiView);
      logger.debug('[ContextAssembly] compression projection cache hit', {
        apiViewMessages: contextApiView.length,
      });
    } else {
      const nextCompressionState = cloneCompressionState(ctx.runtime.compressionState);
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
          protectedToolResultPredicate: (entry) =>
            entry.role === 'tool' &&
            (entry as ContextTranscriptEntry).preserveObservation === true,
          interventions: transcriptInterventions,
        },
      );

      ctx.runtime.compressionState = nextCompressionState;
      persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
      contextApiView = pipelineResult.apiView as ContextTranscriptEntry[];
      cache.compression = {
        key: compressionCacheKey,
        createdAt: now,
        apiView: cloneTranscriptEntries(contextApiView),
        state: nextCompressionState.serialize(),
      };

      const entryIdToOriginMessageId = new Map(
        interventionAdjustedEntries.map((entry) => [entry.id, entry.originMessageId]),
      );
      getContextEventLedger().upsertCompressionEvents(
        ctx.runtime.sessionId,
        ctx.runtime.agentId,
        nextCompressionState.getCommitLog(),
        (messageId) => entryIdToOriginMessageId.get(messageId) ?? messageId,
      );

      const autocompactNeeded = pipelineResult.layersTriggered.includes('autocompact-needed');
      // P2-full/G12: 把 Pipeline 的压力信号交给 ContextPressureController（经
      // checkAndAutoCompress 消费），不再让它只停留在 log/trace。无条件写入，
      // false 也写，避免上一 turn 的 stale true 残留。
      ctx.runtime.pipelineAutocompactNeeded = autocompactNeeded;
      const commitCount = nextCompressionState.getCommitLog().length;
      if (commitCount > 0 || autocompactNeeded) {
        // G12/G20: 真正消费 pipeline 的报告 —— 此前 layersTriggered 只 logger.debug 就丢了，
        // autocompact-needed 是个静默死信号。现在落进结构化 turn trace，并对未执行的 L5 显式 warn。
        ctx.runtime.turnTrace.record('compaction', {
          layersTriggered: pipelineResult.layersTriggered,
          totalTokens: pipelineResult.totalTokens,
          commitCount,
          autocompactNeeded,
        });
        logger.debug('[ContextAssembly] Compression pipeline applied', {
          layersTriggered: pipelineResult.layersTriggered,
          commitCount,
          apiViewMessages: pipelineResult.apiView.length,
        });
        if (autocompactNeeded) {
          logger.warn(
            '[ContextAssembly] Pipeline reports autocompact-needed (usage ≥ 85%) — this path does not auto-execute L5; context stays hot until the AutoContextCompressor path triggers',
            { totalTokens: pipelineResult.totalTokens },
          );
        }
      }
    }
  } catch (error) {
    logger.error('[ContextAssembly] Compression pipeline evaluation failed, falling back to uncompressed transcript:', error);
    ctx.runtime.compressionState = new CompressionState();
  }

  // Allowlist 在循环内不变（只取决于 artifactRepairGuard），提到外面避免重复计算
  const REMOVED_TOOLS = new Set(['TodoWrite', 'todo_write']);
  const repairHistoryAllowlist = getArtifactRepairHistoryToolAllowlist(ctx);
  const repairHistoryAllowedToolCallIds = repairHistoryAllowlist
    ? getAllowedArtifactRepairToolCallIds(ctx, ctx.runtime.messages)
    : null;

  // 预扫:identify toolCallIds whose source assistant entry will drop them via allowlist filter.
  // 必须把对应的 tool message 也跳过,否则成 orphan tool — sanitizeToolCallOrder 会 demote 成 user,
  // 模型看到一堆"无主"的工具结果当成新指令,重复调用同一工具死循环。
  const filteredOutToolCallIds = new Set<string>();
  for (const entry of contextApiView) {
    if (entry.role !== 'assistant') continue;
    const tcEntry = entry as { toolCalls?: Array<{ id: string; name: string }>; content?: string };
    if (!tcEntry.toolCalls?.length) continue;
    const surviving = tcEntry.toolCalls.filter((tc) => {
      if (REMOVED_TOOLS.has(tc.name)) return false;
      if (!repairHistoryAllowlist) return true;
      return repairHistoryAllowedToolCallIds?.has(tc.id) ?? repairHistoryAllowlist.has(tc.name);
    });
    const survivingIds = new Set(surviving.map((tc) => tc.id));
    const willDropAssistant = surviving.length === 0 && !tcEntry.content;
    for (const tc of tcEntry.toolCalls) {
      if (willDropAssistant || !survivingIds.has(tc.id)) {
        filteredOutToolCallIds.add(tc.id);
      }
    }
  }

  logger.debug('[AgentLoop] Building model messages, total messages:', contextApiView.length);
  for (const entry of contextApiView) {
    logger.debug(` Message role=${entry.role}, hasAttachments=${!!entry.attachments?.length}, attachmentCount=${entry.attachments?.length || 0}`);

    if (entry.role === 'tool') {
      // 跳过 source assistant 已被 allowlist 过滤掉的 tool — 防止 orphan
      if (entry.toolCallId && filteredOutToolCallIds.has(entry.toolCallId)) {
        continue;
      }
      modelMessages.push({
        role: 'tool',
        content: entry.content,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(entry.toolError ? { toolError: true } : {}),
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else if (entry.role === 'assistant' && entry.toolCalls?.length) {
      // 过滤掉已废弃工具的历史调用，避免模型从上下文中误判这些工具仍可用
      const tcs = entry.toolCalls.filter((tc) => {
        if (REMOVED_TOOLS.has(tc.name)) return false;
        if (!repairHistoryAllowlist) return true;
        return repairHistoryAllowedToolCallIds?.has(tc.id) ?? repairHistoryAllowlist.has(tc.name);
      });
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
