// ============================================================================
// 语音通话审计时间线（N-L7-AUDIT）——读取聚合，不新建任何写路径
//
// 六本散账按 voiceCallId 拼成一条时间线：
//   DB（真源，永久）：字幕/摘要卡/派活轮（messages）+ 审批（permission_decisions）
//   日志（7 天轮转）：打断三层判定、say-do 干预、派活三元组
//   文件系统：录音目录（可选开关）
//
// fail-loud 铁律（判据 2）：「查过了确实没有」和「没法查」必须长得不一样——
// 每段各自报 status，缺数据带可区分的原因，不许静默略过。
// ============================================================================

import fs from 'fs';
import path from 'path';
import { VOICE_RECORDING_DIR_NAME } from '../../../shared/constants/voice';
import type { VoiceCallSummary } from '../../../shared/contract/voice';
import { getDatabase } from '../core/databaseService';
import type { VoiceAuditMessage } from '../core/repositories/VoiceCallAuditRepository';
import { getUserDataPath } from '../../platform/appPaths';

/** 通话结束后仍追踪审批的窗口：语音派的活寿命跟 run 走，审批常发生在挂断之后。 */
const APPROVAL_TRAIL_AFTER_CALL_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 对外形状
// ---------------------------------------------------------------------------

type VoiceAuditSectionStatus =
  /** 有记录 */
  | 'ok'
  /** 查过了，这一段真的没有事件（数据源在、能查、结果为空） */
  | 'none'
  /** 没法查——note 里写明为什么（日志已轮转 / 旧记录无此字段 / 开关没开） */
  | 'unavailable';

interface VoiceAuditSection<T> {
  status: VoiceAuditSectionStatus;
  /** status 非 ok 时必填：人话说明这一段为什么是空的 */
  note?: string;
  events: T[];
}

export interface VoiceCallListItem {
  /** 旧记录无 voiceCallId 时为 null——时间线仍可用摘要消息 id 拉取 */
  voiceCallId: string | null;
  summaryMessageId: string;
  neoSessionId: string;
  summary: VoiceCallSummary;
}

interface VoiceTranscriptEvent {
  at: number;
  role: string;
  text: string;
  /** exact = metadata.voiceCallId 精确命中；window = 旧记录按时间窗推导 */
  keyMatch: 'exact' | 'window';
}

interface VoiceDispatchEvent {
  at: number;
  workItemId?: string;
  title: string;
  /** host_routed / function_call / xml_fallback；旧记录未落 origin 时为 'unknown' */
  origin: string;
  keyMatch: 'exact' | 'window';
}

interface VoiceApprovalEvent {
  at: number;
  toolName: string;
  summary: string | null;
  outcome: string;
  reason: string;
  waitMs: number | null;
  /** during_call / after_call（挂断后派出的活继续跑产生的审批） */
  phase: 'during_call' | 'after_call';
}

interface VoiceLogEvent {
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

export interface VoiceCallTimeline {
  call: VoiceCallListItem;
  sections: {
    transcript: VoiceAuditSection<VoiceTranscriptEvent>;
    /** 打断三层判定 + 反悔窗（来源：7 天轮转日志） */
    decisions: VoiceAuditSection<VoiceLogEvent>;
    /** say-do 守卫干预 / 不可用（来源：7 天轮转日志） */
    sayDo: VoiceAuditSection<VoiceLogEvent>;
    dispatches: VoiceAuditSection<VoiceDispatchEvent>;
    approvals: VoiceAuditSection<VoiceApprovalEvent>;
    /** 通话内失败留痕 + 派出活的失败/结局印章（来源：DB） */
    outcomes: VoiceAuditSection<VoiceLogEvent>;
  };
  cost: {
    status: VoiceAuditSectionStatus;
    note?: string;
    durationSec: number;
    tokens?: VoiceCallSummary['tokens'];
  };
  recording: {
    status: VoiceAuditSectionStatus;
    note?: string;
    dir?: string;
    files?: string[];
  };
}

// ---------------------------------------------------------------------------
// 通话清单
// ---------------------------------------------------------------------------

export function listVoiceCalls(limit = 50): VoiceCallListItem[] {
  return getDatabase().listVoiceCallSummaries(limit).map((message) => ({
    voiceCallId: message.metadata?.voiceCallSummary?.voiceCallId ?? null,
    summaryMessageId: message.id,
    neoSessionId: message.sessionId,
    summary: message.metadata!.voiceCallSummary!,
  }));
}

// ---------------------------------------------------------------------------
// 日志解析（打断判定 / say-do / 派活三元组的唯一持久落点，7 天轮转）
// ---------------------------------------------------------------------------

/** 值得进时间线的日志 message → 段位归属 */
const DECISION_LOG_MESSAGES = new Set([
  'voice interrupt evidence',
  'voice interrupt decision',
  'voice interrupt delayed discard confirmed',
  'voice interrupt delayed discard revoked',
]);
const SAYDO_LOG_MESSAGES = new Set([
  'voice say/do guard intervened',
  'voice say/do guard unavailable',
]);

interface ParsedLogLine {
  at: number;
  message: string;
  detail: Record<string, unknown>;
}

function logFilesForWindow(logDir: string, from: number, to: number): { present: string[]; missingDates: string[] } {
  const present: string[] = [];
  const missingDates: string[] = [];
  // 日志文件名按 UTC 日期切（logger.getDateString 用 toISOString），这里必须同口径
  const dayMs = 24 * 60 * 60 * 1000;
  for (let day = Math.floor(from / dayMs) * dayMs; day <= to; day += dayMs) {
    const date = new Date(day).toISOString().slice(0, 10);
    const file = path.join(logDir, `code-agent-${date}.log`);
    if (fs.existsSync(file)) present.push(file);
    else missingDates.push(date);
  }
  return { present, missingDates };
}

/** 逐行扫日志，只解析包含 voiceCallId 的行。单文件坏行跳过不失败。 */
function scanLogLinesForCall(files: string[], voiceCallId: string): ParsedLogLine[] {
  const out: ParsedLogLine[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes(voiceCallId)) continue;
      try {
        const parsed = JSON.parse(line) as { timestamp?: string; message?: string; data?: unknown[] };
        if (!parsed.message || !parsed.timestamp) continue;
        const detail = (parsed.data?.[0] ?? {}) as Record<string, unknown>;
        // voiceCallId 可能只出现在别的字段（如 laneKey）；按判定字段核一次身份
        if (detail.voiceSessionId !== voiceCallId && detail.voiceCallId !== voiceCallId
          && !JSON.stringify(detail).includes(voiceCallId)) continue;
        out.push({ at: Date.parse(parsed.timestamp), message: parsed.message, detail });
      } catch {
        continue;
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function logSection(
  lines: ParsedLogLine[],
  wanted: Set<string>,
  missingDates: string[],
  windowFullyRotated: boolean,
): VoiceAuditSection<VoiceLogEvent> {
  const events = lines
    .filter((line) => wanted.has(line.message))
    .map((line) => ({ at: line.at, kind: line.message, detail: line.detail }));
  if (events.length > 0) {
    return {
      status: 'ok',
      events,
      ...(missingDates.length ? { note: `部分日志已轮转（缺 ${missingDates.join(', ')}），此段可能不完整` } : {}),
    };
  }
  if (windowFullyRotated) {
    return { status: 'unavailable', note: '此段无记录可查：判定日志仅保留 7 天，本通电话的日志已轮转删除', events: [] };
  }
  return { status: 'none', note: '日志在、查过了：这一段确实没有事件', events: [] };
}

// ---------------------------------------------------------------------------
// 时间线拼装
// ---------------------------------------------------------------------------

function findCall(idOrSummaryMessageId: string): VoiceCallListItem | null {
  // 摘要卡数量 = 历史通话数，量级小；全取后内存里找，避免为审计加 SQL 形状
  const calls = listVoiceCalls(500);
  return calls.find((c) => c.voiceCallId === idOrSummaryMessageId)
    ?? calls.find((c) => c.summaryMessageId === idOrSummaryMessageId)
    ?? null;
}

export function getVoiceCallTimeline(idOrSummaryMessageId: string): VoiceCallTimeline | null {
  const call = findCall(idOrSummaryMessageId);
  if (!call) return null;
  const { startedAt, endedAt } = call.summary;
  const callId = call.voiceCallId;
  const legacyNote = '旧记录（补键前落库）无通话 ID，按时间窗推导——同窗口混入其他语音消息时无法区分';

  // ---- DB：字幕 / 派活轮 / 失败与结局 ----
  const messages = getDatabase().getVoiceMessagesInWindow(call.neoSessionId, startedAt, endedAt + 1);
  const matches = (m: VoiceAuditMessage): 'exact' | 'window' | 'foreign' => {
    const mid = m.metadata?.voiceCallId;
    if (callId && mid === callId) return 'exact';
    if (mid && callId && mid !== callId) return 'foreign'; // 别通电话的消息混在窗口里，剔除
    return 'window';
  };

  const transcript: VoiceTranscriptEvent[] = [];
  const dispatches: VoiceDispatchEvent[] = [];
  const outcomes: VoiceLogEvent[] = [];
  for (const m of messages) {
    const keyMatch = matches(m);
    if (keyMatch === 'foreign') continue;
    const meta = m.metadata;
    if (meta?.voiceDispatch) {
      dispatches.push({
        at: m.timestamp,
        ...(meta.voiceDispatch.workItemId ? { workItemId: meta.voiceDispatch.workItemId } : {}),
        title: meta.voiceDispatch.title,
        origin: meta.voiceDispatch.origin ?? 'unknown',
        keyMatch,
      });
    } else if (meta?.voiceWorkFailure || meta?.voiceWorkSettled || meta?.voiceCallFailure) {
      const kind = meta.voiceWorkFailure ? 'work_failure' : meta.voiceWorkSettled ? 'work_settled' : 'call_failure';
      outcomes.push({
        at: m.timestamp,
        kind,
        detail: (meta.voiceWorkFailure ?? meta.voiceWorkSettled ?? meta.voiceCallFailure) as unknown as Record<string, unknown>,
      });
    } else if (meta?.source === 'voice' && (m.role === 'user' || m.role === 'assistant')) {
      transcript.push({ at: m.timestamp, role: m.role, text: m.content, keyMatch });
    }
  }

  // ---- DB：审批（session + 时间窗关联；挂断后追踪窗单独标注）----
  const decisions = getDatabase().getPermissionDecisionsBySession(call.neoSessionId, 1000);
  const approvals: VoiceApprovalEvent[] = decisions
    .filter((d) => d.recordedAt >= startedAt && d.recordedAt <= endedAt + APPROVAL_TRAIL_AFTER_CALL_MS)
    .map((d) => ({
      at: d.recordedAt,
      toolName: d.toolName,
      summary: d.summary,
      outcome: d.finalOutcome,
      reason: d.reason,
      waitMs: d.waitMs,
      phase: d.recordedAt <= endedAt ? 'during_call' as const : 'after_call' as const,
    }));

  // ---- 日志：打断判定 / say-do ----
  const logDir = path.join(getUserDataPath(), 'logs');
  const { present, missingDates } = logFilesForWindow(logDir, startedAt, endedAt);
  const windowFullyRotated = present.length === 0;
  const logLines = callId ? scanLogLinesForCall(present, callId) : [];
  const noKeyLogSection = (): VoiceAuditSection<VoiceLogEvent> => (
    { status: 'unavailable', note: legacyNote, events: [] }
  );

  // ---- 文件系统：录音 ----
  let recording: VoiceCallTimeline['recording'];
  const recordingRoot = path.join(getUserDataPath(), VOICE_RECORDING_DIR_NAME);
  if (!callId) {
    recording = { status: 'unavailable', note: legacyNote };
  } else {
    const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(recordingRoot).filter((d) => d.endsWith(`-${safeId}`));
    } catch {
      dirs = [];
    }
    if (dirs.length > 0) {
      const dir = path.join(recordingRoot, dirs[0]!);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir);
      } catch { /* 目录消失当无录音处理，下面 note 说明 */ }
      recording = files.length > 0
        ? { status: 'ok', dir, files }
        : { status: 'unavailable', note: '录音目录存在但文件不可读（可能已被三重上限清理）', dir };
    } else {
      recording = { status: 'none', note: '本通电话未开启录音（开关默认关），或录音已被三重上限清理' };
    }
  }

  const tokens = call.summary.tokens;
  return {
    call,
    sections: {
      transcript: transcript.length > 0
        ? { status: 'ok', events: transcript, ...(callId ? {} : { note: legacyNote }) }
        : { status: 'none', note: '这通电话没有落库任何字幕（摘要卡 transcriptCount 同为 0 时即空通话）', events: [] },
      decisions: callId
        ? logSection(logLines, DECISION_LOG_MESSAGES, missingDates, windowFullyRotated)
        : noKeyLogSection(),
      sayDo: callId
        ? logSection(logLines, SAYDO_LOG_MESSAGES, missingDates, windowFullyRotated)
        : noKeyLogSection(),
      dispatches: dispatches.length > 0
        ? { status: 'ok', events: dispatches }
        : { status: 'none', note: '这通电话没有派出任何任务（与摘要卡 workItemCount 对账）', events: [] },
      approvals: approvals.length > 0
        ? { status: 'ok', events: approvals, note: '审批账无通话键，按会话 + 时间窗关联；同会话同时段的非语音审批会一并列出' }
        : { status: 'none', note: '窗口内该会话没有任何权限决策记录（含挂断后 2 小时追踪窗）', events: [] },
      outcomes: outcomes.length > 0
        ? { status: 'ok', events: outcomes }
        : { status: 'none', note: '无失败留痕、无结局印章', events: [] },
    },
    cost: tokens
      ? { status: 'ok', durationSec: call.summary.durationSec, tokens }
      : {
          status: 'unavailable',
          note: '旧记录（补键前落库）未存单通 token；单通费用不可查，只能看月度总账',
          durationSec: call.summary.durationSec,
        },
    recording,
  };
}

// ---------------------------------------------------------------------------
// 导出（判据 1「一键可查可导出」的导出形态；UI 时间线视图另行设计）
// ---------------------------------------------------------------------------

function fmtTime(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19);
}

function sectionHeader<T>(title: string, section: VoiceAuditSection<T>): string[] {
  const lines = [`## ${title}（${section.status === 'ok' ? `${section.events.length} 条` : section.status === 'none' ? '无事件' : '无记录可查'}）`];
  if (section.note) lines.push(`> ${section.note}`);
  return lines;
}

export function formatVoiceCallTimelineMarkdown(t: VoiceCallTimeline): string {
  const s = t.call.summary;
  const lines: string[] = [
    `# 语音通话审计时间线`,
    '',
    `- 通话：${t.call.voiceCallId ?? `（旧记录无通话 ID，摘要卡 ${t.call.summaryMessageId}）`}`,
    `- 会话：${t.call.neoSessionId}`,
    `- 时间：${fmtTime(s.startedAt)} → ${fmtTime(s.endedAt)}（${s.durationSec}s）`,
    `- 模型：${s.provider} / ${s.conversationModel} · 派单 ${s.workItemCount} · 字幕 ${s.transcriptCount ?? '未记录'}`,
    '',
    ...sectionHeader('谁说了什么', t.sections.transcript),
    ...t.sections.transcript.events.map((e) => `- ${fmtTime(e.at)} [${e.role}]${e.keyMatch === 'window' ? '（窗推导）' : ''} ${e.text}`),
    '',
    ...sectionHeader('打断判定（三层链 + 反悔窗）', t.sections.decisions),
    ...t.sections.decisions.events.map((e) => `- ${fmtTime(e.at)} ${e.kind} ${JSON.stringify(e.detail)}`),
    '',
    ...sectionHeader('说了没做守卫', t.sections.sayDo),
    ...t.sections.sayDo.events.map((e) => `- ${fmtTime(e.at)} ${e.kind} ${JSON.stringify(e.detail)}`),
    '',
    ...sectionHeader('派单', t.sections.dispatches),
    ...t.sections.dispatches.events.map((e) => `- ${fmtTime(e.at)} ${e.title}（${e.workItemId ?? '无 workItemId'} · 派法 ${e.origin}${e.keyMatch === 'window' ? ' · 窗推导' : ''}）`),
    '',
    ...sectionHeader('审批', t.sections.approvals),
    ...t.sections.approvals.events.map((e) => `- ${fmtTime(e.at)} ${e.toolName} → ${e.outcome}（${e.reason}${e.waitMs != null ? ` · 等待 ${e.waitMs}ms` : ''}${e.phase === 'after_call' ? ' · 挂断后' : ''}）${e.summary ? ` ${e.summary}` : ''}`),
    '',
    ...sectionHeader('失败与结局', t.sections.outcomes),
    ...t.sections.outcomes.events.map((e) => `- ${fmtTime(e.at)} ${e.kind} ${JSON.stringify(e.detail)}`),
    '',
    `## 费用`,
    ...(t.cost.status === 'ok' && t.cost.tokens
      ? [`- 时长 ${t.cost.durationSec}s · token 共 ${t.cost.tokens.totalTokens}（入 ${t.cost.tokens.inputTokens} = 音频 ${t.cost.tokens.inputAudioTokens} + 文本 ${t.cost.tokens.inputTextTokens}；出 ${t.cost.tokens.outputTokens} = 音频 ${t.cost.tokens.outputAudioTokens} + 文本 ${t.cost.tokens.outputTextTokens}）`]
      : [`> ${t.cost.note ?? '无记录'}（时长 ${t.cost.durationSec}s）`]),
    '',
    `## 录音`,
    ...(t.recording.status === 'ok'
      ? [`- ${t.recording.dir}（${t.recording.files?.join(', ')}）`]
      : [`> ${t.recording.note ?? '无'}`]),
    '',
  ];
  return lines.join('\n');
}
