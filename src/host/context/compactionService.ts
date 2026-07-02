import type { ModelConfig } from '../../shared/contract/model';
import type { ToolResultArchiveRef } from '../utils/toolResultSpill';
import type {
  CompactionBlock,
  CompactionSource,
  CompactionSurvivorManifest,
  Message,
  MessageRole,
} from '../../shared/contract';
import type { ToolCall, ToolResult } from '../../shared/contract/tool';
import { estimateTokens } from './tokenEstimator';
import { COMPACTION_ECONOMICS } from '../../shared/constants';
import {
  compactModelSummarizeWithMetadata,
  type CompactModelSummaryMetadata,
} from './compactModel';
import { recordCompactionAuditSnapshot } from './compactionAuditRecorder';
import {
  runPostCompactHooks,
  runPreCompactHooks,
  type CompactionHookManagerLike,
} from './compactionHooks';
import { dataFingerprintStore } from '../tools/dataFingerprint';
import { fileReadTracker } from '../tools/fileReadTracker';
import { createLogger } from '../services/infra/logger';
import {
  buildSurvivorManifest,
  compactMessagesForSummary,
  renderSurvivorManifestForPrompt,
  type ContextSurvivorManifest,
  type SurvivorManifestMessage,
} from './survivorManifest';
import {
  buildSummaryRepairInstruction,
  validateCompactionSummary,
  type CompactionSummaryValidation,
} from './compactionSummaryValidator';

const SUMMARY_VERSION = 1;
const DEFAULT_PRESERVE_RECENT_COUNT = 10;
const SUMMARY_MAX_TOKENS = 1000;
const TRANSCRIPT_MAX_TOKENS = 12000;
const TRANSCRIPT_ITEM_MAX_CHARS = 1200;
const TOOL_ARGS_MAX_CHARS = 700;
const TOOL_ERROR_MAX_CHARS = 600;
const logger = createLogger('CompactionService');

export interface CompactionPlanOptions {
  sessionId: string;
  source: CompactionSource;
  messages: Message[];
  anchorMessageId?: string;
  preserveRecentCount?: number;
  systemPrompt?: string;
  modelConfig?: Pick<ModelConfig, 'provider' | 'model'>;
  hookManager?: CompactionHookManagerLike;
  usagePercent?: number | null;
  skipAudit?: boolean;
  now?: number;
  archivedToolResults?: ToolResultArchiveRef[];
}

export interface CompactionPlan {
  sessionId: string;
  source: CompactionSource;
  anchorMessageId?: string;
  preserveRecentCount: number;
  messages: Message[];
  compactedMessages: Message[];
  preservedMessages: Message[];
  manifest: ContextSurvivorManifest;
  contentToSummarize: string;
  originalTokens: number;
  systemPrompt?: string;
  modelConfig?: Pick<ModelConfig, 'provider' | 'model'>;
  hookPreservedContext?: string;
}

export interface CompactionServiceResult {
  success: boolean;
  reason?: string;
  plan: CompactionPlan;
  summary?: string;
  summaryMessage?: Message;
  newMessages?: Message[];
  block?: CompactionBlock;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  validation?: CompactionSummaryValidation;
  summaryModel?: CompactModelSummaryMetadata;
  warnings: string[];
  /** WP2-3 经济学闸账目：净节省 = (originalTokens − summaryTokens) − 调用成本×权重 */
  netSavings?: { netSavedTokens: number; callCostTokens: number };
}

function messageId(message: Message, index: number): string {
  return message.id || `message-${index}`;
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function clampPromptText(value: string, maxChars: number): string {
  const text = normalizePromptText(value);
  if (text.length <= maxChars) return text;
  const marker = '... [truncated] ...';
  const head = Math.max(0, Math.floor(maxChars * 0.65));
  const tail = Math.max(0, maxChars - head - marker.length);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function summarizeOmittedText(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text ? `[omitted ${text.length} chars]` : '[omitted]';
}

const SENSITIVE_TRANSCRIPT_KEY_RE = /api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|secret|token/i;
const RAW_TRANSCRIPT_KEY_RE = /base64|body|content|data|html|image|localStorage|output|screenshot|sessionStorage|text/i;

function sanitizeForTranscript(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_TRANSCRIPT_KEY_RE.test(key)) {
    return '[redacted]';
  }
  if (key && RAW_TRANSCRIPT_KEY_RE.test(key)) {
    return summarizeOmittedText(value);
  }
  if (typeof value === 'string') {
    return clampPromptText(value, TOOL_ARGS_MAX_CHARS);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array length=${value.length}]`;
    return value.slice(0, 8).map((item) => sanitizeForTranscript(item, undefined, depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= 2) {
    return { keys: entries.map(([entryKey]) => entryKey).slice(0, 20) };
  }
  return Object.fromEntries(
    entries.slice(0, 30).map(([entryKey, item]) => [
      entryKey,
      sanitizeForTranscript(item, entryKey, depth + 1),
    ]),
  );
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    return clampPromptText(JSON.stringify(value), maxChars);
  } catch {
    return clampPromptText(String(value), maxChars);
  }
}

function summarizeToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    name: call.name,
    arguments: sanitizeForTranscript(call.arguments),
  };
}

function summarizeToolResult(result: ToolResult, call?: ToolCall): Record<string, unknown> {
  return {
    toolCallId: result.toolCallId,
    tool: call?.name,
    success: result.success,
    output: result.output ? summarizeOmittedText(result.output) : undefined,
    error: result.error ? clampPromptText(result.error, TOOL_ERROR_MAX_CHARS) : undefined,
    outputPath: result.outputPath,
    duration: result.duration,
    metadata: result.metadata ? sanitizeForTranscript(result.metadata) : undefined,
  };
}

function summarizeAttachments(message: Message): Array<Record<string, unknown>> {
  return (message.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    category: attachment.category,
    name: attachment.name,
    size: attachment.size,
    mimeType: attachment.mimeType,
    path: attachment.path,
    pageCount: attachment.pageCount,
    sheetCount: attachment.sheetCount,
    rowCount: attachment.rowCount,
    folderStats: attachment.folderStats,
    data: attachment.data ? summarizeOmittedText(attachment.data) : undefined,
    files: attachment.files ? `[${attachment.files.length} files omitted]` : undefined,
  }));
}

function serializeForCompaction(message: Message): string {
  const parts: string[] = [];
  if (message.role === 'tool' && message.content) {
    parts.push(`[tool output omitted from compaction transcript: ${message.content.length} chars; see Survivor Manifest for paths, errors, commands, and open work]`);
  } else if (message.content) {
    parts.push(message.content);
  }

  if (message.toolCalls?.length) {
    parts.push(`[tool calls]\n${safeJson(message.toolCalls.map(summarizeToolCall), TOOL_ARGS_MAX_CHARS)}`);
  }

  if (message.toolResults?.length) {
    const callsById = new Map((message.toolCalls ?? []).map((call) => [call.id, call]));
    parts.push(`[tool results]\n${safeJson(
      message.toolResults.map((result) => summarizeToolResult(result, callsById.get(result.toolCallId))),
      TOOL_ARGS_MAX_CHARS,
    )}`);
  }

  if (message.attachments?.length) {
    parts.push(`[attachments]\n${safeJson(summarizeAttachments(message), TOOL_ARGS_MAX_CHARS)}`);
  }

  return parts.join('\n\n');
}

function toTranscriptMessage(message: Message): SurvivorManifestMessage {
  return {
    ...message,
    content: serializeForCompaction(message),
    toolCalls: undefined,
    toolResults: undefined,
    attachments: undefined,
    reasoning: undefined,
    thinking: undefined,
  };
}

function splitMessages(
  messages: Message[],
  anchorMessageId: string | undefined,
  preserveRecentCount: number,
): { anchorMessageId?: string; compactedMessages: Message[]; preservedMessages: Message[] } {
  if (anchorMessageId) {
    const index = messages.findIndex((message) => message.id === anchorMessageId);
    if (index > 0) {
      return {
        anchorMessageId,
        compactedMessages: messages.slice(0, index),
        preservedMessages: messages.slice(index),
      };
    }
  }

  const preservedCount = Math.min(
    preserveRecentCount,
    Math.max(1, messages.length - 2),
  );
  const boundary = Math.max(1, messages.length - preservedCount);
  return {
    anchorMessageId: messages[boundary]?.id,
    compactedMessages: messages.slice(0, boundary),
    preservedMessages: messages.slice(boundary),
  };
}

function countMessageTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(serializeForCompaction(message)), 0);
}

function buildTranscript(messages: Message[]): string {
  return compactMessagesForSummary(messages.map(toTranscriptMessage), {
    maxItemChars: TRANSCRIPT_ITEM_MAX_CHARS,
    maxTotalTokens: TRANSCRIPT_MAX_TOKENS,
  })
    .map((message) => `[${message.role}${message.id ? ` ${message.id}` : ''}]: ${message.content}`)
    .join('\n\n---\n\n');
}

function toSharedManifest(manifest: ContextSurvivorManifest): CompactionSurvivorManifest {
  return {
    sessionId: manifest.sessionId,
    source: manifest.source as CompactionSource | undefined,
    anchorMessageId: manifest.anchorMessageId,
    preserveRecentCount: manifest.preserveRecentCount,
    compactedMessageIds: manifest.compactedMessageIds,
    preservedMessageIds: manifest.preservedMessageIds,
    files: manifest.files.map((file) => ({
      path: file.path,
      needsReRead: file.needsReRead,
      reason: file.excerpt
        ? `${file.lastKnownReason || file.reason || 'referenced_before_compaction'}; observed excerpt only, re-read before relying on or editing.`
        : `${file.lastKnownReason || file.reason || 'referenced_before_compaction'}; path retained only, re-read before relying on or editing.`,
      survival: file.survival,
      digest: file.digest,
      excerpt: file.excerpt,
      metadata: file.metadata,
    })),
    commands: manifest.commands.map((command) => ({
      label: command.command,
      detail: [
        command.cwd ? `cwd=${command.cwd}` : '',
        command.exitCode !== undefined ? `exit=${command.exitCode}` : '',
        command.stderrSummary ? `stderr=${command.stderrSummary}` : '',
        command.stdoutSummary ? `stdout=${command.stdoutSummary}` : '',
      ].filter(Boolean).join(' | '),
      severity: command.success === false ? 'error' : 'info',
    })),
    errors: manifest.errors.map((error) => ({
      label: 'Unresolved error',
      detail: error.text,
      severity: 'error',
    })),
    openWork: manifest.todos.map((todo) => ({
      label: 'Open work',
      detail: todo.text,
      severity: 'warning',
    })),
    artifacts: manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      reason: artifact.source,
    })),
    archivedToolResults: manifest.archivedToolResults.map((archive) => ({
      label: archive.artifactId,
      detail: [
        `tool=${archive.toolName}`,
        `reason=${archive.reason}`,
        `path=${archive.filePath}`,
        `bytes=${archive.bytes}`,
        `sha256=${archive.sha256}`,
        archive.sourceMessageId ? `message=${archive.sourceMessageId}` : '',
        archive.toolCallId ? `toolCall=${archive.toolCallId}` : '',
        `recover=read_tool_result_archive artifact_id=${archive.artifactId}`,
      ].filter(Boolean).join(' | '),
      severity: 'info',
    })),
    dataFingerprint: manifest.dataFingerprintText || undefined,
  };
}

function buildSummaryPrompt(plan: CompactionPlan, previousSummary?: string, repairInstruction?: string): string {
  const repairBlock = previousSummary && repairInstruction
    ? `\n\nPrevious summary:\n${previousSummary}\n\nRepair instruction:\n${repairInstruction}\n\nRegenerate the full handoff summary with the missing survivor items included.`
    : '';
  const preservedContextBlock = plan.hookPreservedContext
    ? `\n\nPreserved Context From PreCompact Hooks:\n${plan.hookPreservedContext.slice(0, 4000)}`
    : '';

  return `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume this task.

Use this exact markdown shape:
# Context Handoff

## Current State
## Files And Changes
## Commands And Evidence
## Errors And Resolutions
## User Preferences And Constraints
## Open Work
## Continue From Here
## Needs Re-read

Hard rules:
- Preserve every absolute file path from the Survivor Manifest, or explicitly put it in Needs Re-read.
- File survivor excerpts and digests are stale observations from before compaction, not proof of current file contents.
- Never claim to know a file's latest contents from a survivor record; tell the next model to re-read before editing, quoting, or relying on it.
- If a file survivor is path_only, only preserve the path and the reason it matters.
- Preserve unresolved errors and failed commands.
- Preserve open work and TODO items.
- Do not invent files, commands, tests, or outcomes.
- Be specific enough that the next model can continue without the old messages.
- Keep the summary under 900 words.

System prompt context:
${plan.systemPrompt ? plan.systemPrompt.slice(0, 4000) : '(none)'}
${preservedContextBlock}

Survivor Manifest:
${renderSurvivorManifestForPrompt(plan.manifest)}

Compacted Transcript:
${plan.contentToSummarize}${repairBlock}

Generate the handoff summary:`;
}

export function createCompactionPlan(options: CompactionPlanOptions): CompactionPlan | null {
  if (options.messages.length < 3) return null;

  const preserveRecentCount = Math.max(0, options.preserveRecentCount ?? DEFAULT_PRESERVE_RECENT_COUNT);
  const split = splitMessages(options.messages, options.anchorMessageId, preserveRecentCount);
  if (split.compactedMessages.length < 2) return null;

  const compactedMessageIds = split.compactedMessages.map(messageId);
  const preservedMessageIds = split.preservedMessages.map(messageId);
  const manifest = buildSurvivorManifest(options.messages, {
    sessionId: options.sessionId,
    source: options.source,
    anchorMessageId: split.anchorMessageId,
    preserveRecentCount,
    compactedMessageIds,
    preservedMessageIds,
    maxTokens: 8000,
    maxItemChars: 900,
    fileReadRecords: fileReadTracker.getRecentFiles(80),
    dataFingerprintText: dataFingerprintStore.toSummary(),
    archivedToolResults: options.archivedToolResults,
  });
  const contentToSummarize = buildTranscript(split.compactedMessages);

  return {
    sessionId: options.sessionId,
    source: options.source,
    anchorMessageId: split.anchorMessageId,
    preserveRecentCount,
    messages: options.messages,
    compactedMessages: split.compactedMessages,
    preservedMessages: split.preservedMessages,
    manifest,
    contentToSummarize,
    originalTokens: countMessageTokens(split.compactedMessages),
    systemPrompt: options.systemPrompt,
    modelConfig: options.modelConfig,
  };
}

function recordAudit(result: CompactionServiceResult, options: CompactionPlanOptions): void {
  if (options.skipAudit) return;
  recordCompactionAuditSnapshot({
    result,
    usagePercent: options.usagePercent,
    createdAt: options.now,
  });
}

export async function summarizeCompactionPlan(plan: CompactionPlan): Promise<{
  summary: string;
  validation: CompactionSummaryValidation;
  summaryModel: CompactModelSummaryMetadata;
  warnings: string[];
  /** 摘要调用消耗（prompt 输入 + 摘要输出，含 repair 重试），供经济学闸算净节省 */
  callCostTokens: number;
}> {
  const prompt = buildSummaryPrompt(plan);
  let summaryResult = await compactModelSummarizeWithMetadata(prompt, SUMMARY_MAX_TOKENS);
  let summary = summaryResult.summary;
  let summaryModel = summaryResult.metadata;
  let callCostTokens = estimateTokens(prompt) + estimateTokens(summary);
  let validation = validateCompactionSummary(summary, toSharedManifest(plan.manifest));
  const warnings = [...validation.warnings];

  if (!validation.ok) {
    const repairInstruction = buildSummaryRepairInstruction(validation);
    const repairPrompt = buildSummaryPrompt(plan, summary, repairInstruction);
    summaryResult = await compactModelSummarizeWithMetadata(repairPrompt, SUMMARY_MAX_TOKENS);
    summary = summaryResult.summary;
    summaryModel = summaryResult.metadata;
    callCostTokens += estimateTokens(repairPrompt) + estimateTokens(summary);
    validation = validateCompactionSummary(summary, toSharedManifest(plan.manifest));
    warnings.push(...validation.warnings);
  }

  if (!validation.ok) {
    warnings.push('Summary missed survivor manifest items; deterministic manifest was prepended.');
    summary = [
      '# Deterministic Survivor Manifest',
      renderSurvivorManifestForPrompt(plan.manifest),
      '',
      summary,
    ].join('\n');
  }

  return { summary, validation, summaryModel, warnings, callCostTokens };
}

export async function compactMessagesWithSummary(
  options: CompactionPlanOptions,
): Promise<CompactionServiceResult> {
  const plan = createCompactionPlan(options);
  if (!plan) {
    const beforeTokens = countMessageTokens(options.messages);
    const result: CompactionServiceResult = {
      success: false,
      reason: 'too_few_messages',
      plan: {
        sessionId: options.sessionId,
        source: options.source,
        preserveRecentCount: options.preserveRecentCount ?? DEFAULT_PRESERVE_RECENT_COUNT,
        messages: options.messages,
        compactedMessages: [],
        preservedMessages: options.messages,
        manifest: buildSurvivorManifest(options.messages, {
          sessionId: options.sessionId,
          source: options.source,
          preserveRecentCount: options.preserveRecentCount ?? DEFAULT_PRESERVE_RECENT_COUNT,
          archivedToolResults: options.archivedToolResults,
        }),
        contentToSummarize: '',
        originalTokens: 0,
        systemPrompt: options.systemPrompt,
        modelConfig: options.modelConfig,
      },
      beforeTokens,
      afterTokens: beforeTokens,
      savedTokens: 0,
      warnings: [],
    };
    recordAudit(result, options);
    return result;
  }

  const beforeTokens = countMessageTokens(options.messages);

  // WP2-3 净节省预闸（仅自动触发源）：最好情况净节省 = originalTokens −
  // prompt 输入成本×权重（摘要输出趋 0 的理想化上界）。连上界都不过阈值，
  // 直接跳过付费摘要调用——省调用费，也不打掉 prompt cache 前缀。
  const economicsGated = plan.source === 'auto_threshold';
  if (economicsGated) {
    const promptCostTokens = estimateTokens(buildSummaryPrompt(plan));
    const bestCaseNetSavings = plan.originalTokens
      - promptCostTokens * COMPACTION_ECONOMICS.CALL_COST_WEIGHT;
    if (bestCaseNetSavings < COMPACTION_ECONOMICS.MIN_NET_SAVINGS_TOKENS) {
      logger.info(
        `[CompactionService] Net-savings pre-gate rejected compaction: best-case ${Math.round(bestCaseNetSavings)} < ${COMPACTION_ECONOMICS.MIN_NET_SAVINGS_TOKENS} tokens (original=${plan.originalTokens})`,
      );
      const result: CompactionServiceResult = {
        success: false,
        reason: 'net_savings_below_threshold',
        plan,
        beforeTokens,
        afterTokens: beforeTokens,
        savedTokens: 0,
        netSavings: { netSavedTokens: Math.round(bestCaseNetSavings), callCostTokens: 0 },
        warnings: [],
      };
      recordAudit(result, options);
      return result;
    }
  }

  const hookResult = await runPreCompactHooks({
    hookManager: options.hookManager,
    sessionId: options.sessionId,
    messages: options.messages,
    tokenCount: beforeTokens,
    targetTokenCount: countMessageTokens(plan.preservedMessages) + SUMMARY_MAX_TOKENS,
    logger,
  });
  const planWithHooks: CompactionPlan = hookResult.preservedContext
    ? { ...plan, hookPreservedContext: hookResult.preservedContext }
    : plan;
  const summaryResult = await summarizeCompactionPlan(planWithHooks);
  const { summary, validation, summaryModel } = summaryResult;
  const warnings = [...hookResult.warnings, ...summaryResult.warnings];
  const compactedAt = options.now ?? Date.now();
  const firstPreservedTimestamp = planWithHooks.preservedMessages[0]?.timestamp;
  const summaryMessageTimestamp = typeof firstPreservedTimestamp === 'number'
    ? Math.min(compactedAt, firstPreservedTimestamp - 1)
    : compactedAt;
  const summaryContent = `[Context Handoff] Another language model worked on this task and produced the following summary. Use this to build on the work already done.\n\n${summary}`;
  const summaryTokens = estimateTokens(summaryContent);
  const savedTokens = Math.max(0, planWithHooks.originalTokens - summaryTokens);
  const netSavedTokens = Math.round(
    (planWithHooks.originalTokens - summaryTokens)
    - summaryResult.callCostTokens * COMPACTION_ECONOMICS.CALL_COST_WEIGHT,
  );
  const netSavings = { netSavedTokens, callCostTokens: summaryResult.callCostTokens };

  if (summaryTokens >= planWithHooks.originalTokens) {
    const result: CompactionServiceResult = {
      success: false,
      reason: 'summary_not_smaller',
      plan: planWithHooks,
      summary,
      beforeTokens,
      afterTokens: beforeTokens,
      savedTokens: 0,
      validation,
      summaryModel,
      netSavings,
      warnings,
    };
    recordAudit(result, options);
    return result;
  }

  // WP2-3 净节省后闸（仅自动触发源）：真实摘要出来后按实际数字复核，
  // 省的抵不过调用成本×权重 + 阈值 → 不提交（调用费已沉没，但不再打掉 prefix cache）。
  if (economicsGated && netSavedTokens < COMPACTION_ECONOMICS.MIN_NET_SAVINGS_TOKENS) {
    logger.info(
      `[CompactionService] Net-savings gate rejected compaction: ${netSavedTokens} < ${COMPACTION_ECONOMICS.MIN_NET_SAVINGS_TOKENS} tokens (saved=${savedTokens}, callCost=${summaryResult.callCostTokens})`,
    );
    const result: CompactionServiceResult = {
      success: false,
      reason: 'net_savings_below_threshold',
      plan: planWithHooks,
      summary,
      beforeTokens,
      afterTokens: beforeTokens,
      savedTokens: 0,
      validation,
      summaryModel,
      netSavings,
      warnings,
    };
    recordAudit(result, options);
    return result;
  }

  const block: CompactionBlock = {
    type: 'compaction',
    content: summaryContent,
    timestamp: compactedAt,
    compactedMessageCount: planWithHooks.compactedMessages.length,
    compactedTokenCount: savedTokens,
    source: planWithHooks.source,
    summaryVersion: SUMMARY_VERSION,
    anchorMessageId: planWithHooks.anchorMessageId,
    compactedMessageIds: planWithHooks.manifest.compactedMessageIds,
    preservedMessageIds: planWithHooks.manifest.preservedMessageIds,
    survivorManifest: toSharedManifest(planWithHooks.manifest),
    provider: summaryModel.provider,
    model: summaryModel.model,
    warnings,
  };

  const summaryMessage: Message = {
    id: `compact-summary-${compactedAt}-0`,
    role: 'system' as MessageRole,
    content: summaryContent,
    timestamp: summaryMessageTimestamp,
    compaction: block,
  };
  const newMessages = [summaryMessage, ...planWithHooks.preservedMessages];
  const afterTokens = countMessageTokens(newMessages);
  const postHookResult = await runPostCompactHooks({
    hookManager: options.hookManager,
    sessionId: options.sessionId,
    savedTokens: beforeTokens - afterTokens,
    strategy: planWithHooks.source,
    logger,
  });
  if (postHookResult.warnings.length > 0) {
    warnings.push(...postHookResult.warnings);
    block.warnings = warnings;
  }

  const result: CompactionServiceResult = {
    success: true,
    plan: planWithHooks,
    summary,
    summaryMessage,
    newMessages,
    block,
    beforeTokens,
    afterTokens,
    savedTokens: beforeTokens - afterTokens,
    validation,
    summaryModel,
    netSavings,
    warnings,
  };
  recordAudit(result, options);
  return result;
}
