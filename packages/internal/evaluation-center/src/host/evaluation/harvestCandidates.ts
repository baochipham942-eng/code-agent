// ============================================================================
// 从会话转成题目 —— 候选判定标准推导（纯函数）
// ----------------------------------------------------------------------------
// 只看结构化回放里的事实（工具调用、参数、会话级质量标记），不把助手回复正文
// 塞进题目。推出来的每条都带一句「为什么推出来」，人在草稿表单里逐条确认；
// 没被人点过的不会进正式集（设计档 §10 / 对齐页 B8）。
//
// 点踩轮的定位：ReplayTurn 契约里没有 turn id（只有 turnNumber / parentTurnId），
// 而 telemetry_feedback 的 turnId/messageId 写的是 assistant message.id，与
// telemetry turn 不是一套 id（trajectoryToCase.ts:64-68 已记录）。所以这里按
// trajectoryToCase 的第二级 fallback 走时间锚：取 startTime 不晚于点踩时刻的
// 最后一轮，都不满足则取第一轮。
// ============================================================================

import path from 'node:path';
import { shortSessionIdForFileName } from '@shared/utils/id';
import type {
  HarvestCandidate,
  HarvestDraftSeed,
  HarvestFieldKey,
  HarvestSeedNote,
  ReplayTurn,
  StructuredReplay,
} from '@shared/contract/evaluation';

/** 工具参数里可能装文件路径的键（Write/Edit 家族的 schema 各不相同）。 */
const PATH_ARG_KEYS = ['file_path', 'path', 'filePath', 'target_file', 'file'] as const;
/** 工具参数里可能装命令的键。 */
const COMMAND_ARG_KEYS = ['command', 'cmd'] as const;

export interface HarvestDeriveInput {
  replay: StructuredReplay;
  sessionTitle: string;
  /** 会话工作目录；空字符串表示未知（此时绝对路径一律不出候选）。 */
  workingDirectory: string;
  /** B7 字段映射清单里被勾上的行。 */
  fields: HarvestFieldKey[];
  /** 批次标签，如 harvest-0904。 */
  batchTag: string;
  /** 该会话的点踩时刻（telemetry_feedback.created_at，rating=-1），可为空。 */
  negativeFeedbackAt: number[];
}

function firstString(args: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 绝对路径转成相对会话工作目录的路径；越出工作区的一律返回 null（不出候选）。
 * 相对路径原样保留——断言引擎本来就按 workingDirectory 拼。
 */
function toWorkspaceRelativePath(rawPath: string, workingDirectory: string): string | null {
  if (!rawPath.trim()) return null;
  let candidate = rawPath.trim();
  if (path.isAbsolute(candidate)) {
    if (!workingDirectory) return null;
    const relative = path.relative(workingDirectory, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    candidate = relative;
  }
  const normalized = path.normalize(candidate);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  return normalized.split(path.sep).join('/');
}

/** 时间锚定位点踩那一轮：startTime 不晚于点踩时刻的最后一轮，都不满足取第一轮。 */
function resolveFeedbackTurn(turns: ReplayTurn[], anchorTimestamp: number): ReplayTurn | null {
  if (turns.length === 0) return null;
  let matched: ReplayTurn | null = null;
  for (const turn of turns) {
    if (turn.startTime <= anchorTimestamp) matched = turn;
  }
  return matched ?? turns[0];
}

function candidateKey(candidate: HarvestCandidate): string {
  return `${candidate.type}|${JSON.stringify(candidate.params)}`;
}

/**
 * 推候选判定标准。顺序 = 对齐页 B8 的顺序：写文件 → 调过的工具 → 点踩轮反向候选。
 * 推不出任何一条时返回空数组，调用方给「需手动补一条」的提示——不编造。
 */
function deriveExpectationCandidates(input: {
  replay: StructuredReplay;
  workingDirectory: string;
  negativeFeedbackAt: number[];
}): { candidates: HarvestCandidate[]; notes: HarvestSeedNote[] } {
  const { replay, workingDirectory, negativeFeedbackAt } = input;
  const turns = replay.turns ?? [];
  const fileCandidates: HarvestCandidate[] = [];
  const toolCandidates: HarvestCandidate[] = [];
  const commandCandidates: HarvestCandidate[] = [];
  const seenTools = new Set<string>();

  for (const turn of turns) {
    for (const block of turn.blocks ?? []) {
      const call = block.type === 'tool_call' ? block.toolCall : undefined;
      if (!call) continue;
      if (call.name && !seenTools.has(call.name)) {
        seenTools.add(call.name);
        toolCandidates.push({
          type: 'tool_called',
          params: { tool: call.name },
          reason: `会话里调用了 ${call.name}`,
        });
      }
      if (call.category !== 'Write' && call.category !== 'Edit') continue;
      const rawPath = firstString(call.actualArgs, PATH_ARG_KEYS) ?? firstString(call.args, PATH_ARG_KEYS);
      if (!rawPath) continue;
      const relative = toWorkspaceRelativePath(rawPath, workingDirectory);
      if (!relative) continue;
      fileCandidates.push({
        type: 'file_exists',
        params: { path: relative },
        reason: `会话里写了 ${relative}`,
      });
    }
  }

  const notes: HarvestSeedNote[] = [];
  for (const anchor of negativeFeedbackAt) {
    const turn = resolveFeedbackTurn(turns, anchor);
    const command = turn?.blocks
      .map((block) => (block.type === 'tool_call' && block.toolCall?.category === 'Bash'
        ? firstString(block.toolCall.actualArgs, COMMAND_ARG_KEYS) ?? firstString(block.toolCall.args, COMMAND_ARG_KEYS)
        : null))
      .find((value): value is string => Boolean(value));
    if (command) {
      commandCandidates.push({
        type: 'command_succeeds',
        params: { command },
        reason: '点踩那轮的反向候选',
      });
    } else if (!notes.includes('negativeFeedbackNeedsManual')) {
      notes.push('negativeFeedbackNeedsManual');
    }
  }

  const deduped: HarvestCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...fileCandidates, ...toolCandidates, ...commandCandidates]) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  if (deduped.length === 0) notes.unshift('noCandidates');
  return { candidates: deduped, notes };
}

/** 会话首轮用户原话（题面来源）——只取 user 块，助手回复不进题目。 */
function firstUserPrompt(replay: StructuredReplay): string | null {
  for (const turn of replay.turns ?? []) {
    for (const block of turn.blocks ?? []) {
      if (block.type === 'user' && block.content.trim()) return block.content.trim();
    }
  }
  return null;
}

/** 工具调用序列摘要，只在「工具调用序列」那行被勾上时写进描述（默认不勾，防题面泄答案）。 */
function toolTraceSummary(replay: StructuredReplay): string {
  const names: string[] = [];
  for (const turn of replay.turns ?? []) {
    for (const block of turn.blocks ?? []) {
      const name = block.type === 'tool_call' ? block.toolCall?.name : undefined;
      if (name && names[names.length - 1] !== name) names.push(name);
    }
  }
  return names.join(' → ');
}

/** 把一场会话的回放变成一份草稿预填内容。 */
export function deriveHarvestSeed(input: HarvestDeriveInput): HarvestDraftSeed {
  const { replay, sessionTitle, workingDirectory, fields, batchTag, negativeFeedbackAt } = input;
  const prompt = firstUserPrompt(replay) ?? '';
  const tags = [batchTag];
  if (fields.includes('qualityTags')) {
    const grade = replay.summary?.qualityScore?.grade;
    if (grade) tags.push(`quality-${grade}`);
  }
  const trace = fields.includes('toolTrace') ? toolTraceSummary(replay) : '';
  const description = trace ? `${sessionTitle}（会话里的工具调用：${trace}）` : sessionTitle;
  const { candidates, notes } = deriveExpectationCandidates({ replay, workingDirectory, negativeFeedbackAt });

  return {
    sessionId: replay.sessionId,
    sessionTitle,
    id: `draft-${shortSessionIdForFileName(replay.sessionId)}`,
    prompt,
    description,
    tags,
    candidates,
    notes,
  };
}
