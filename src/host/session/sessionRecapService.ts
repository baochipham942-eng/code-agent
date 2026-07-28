// ============================================================================
// Session Recap Service —— 回会话追赶提示（A6）
// ============================================================================
//
// 场景：用户隔天/隔小时回到一个会话（尤其 agent 在后台跑完了活的会话），需要一句话
// 知道"我不在的时候产出发生了什么变化"。
//
// 硬约束（评审阶段钉死）：**素材只来自产物变化 + 任务账本结果，禁止读聊天消息流水**。
// 读消息流水会产出"执行了某某工具、报了某某错"的流水账，非程序员看不懂。所以本文件
// 的两个素材源是：
//   1. completionSummaryService 的 run 记录 —— 每轮收口时落的产物快照
//      （artifactRefs / changedFiles / status / blockers），这就是"产物 diff"的现成来源；
//   2. session task ledger（ADR-050 证据门）—— completed / blocked 的结果与已语义化的
//      blockedReason。
// 两者都拿不到素材就返回 null（没什么可追赶的），不编。
//
// 生成走 quickModel fire-and-forget：小模型、不阻塞主链路、不可用时静默降级成纯规则
// 拼接（"N 项完成、M 项卡住"）。参考 sessionManager.generateSmartTitle 的同款用法。
// ============================================================================

import type { SessionTask } from '../../shared/contract';
import type { CompletionSummaryRecord } from '../../shared/contract';
import { readCompletionSummaryRecordsBySession } from './completionSummaryService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionRecap');

/** 一句话追赶提示的展示上限，超了就不是"一眼扫完"了 */
const MAX_RECAP_LENGTH = 120;

/** 喂给小模型的素材条数上限：再多也只是重复，白花 token */
const MAX_ARTIFACTS_IN_PROMPT = 8;
const MAX_TASKS_IN_PROMPT = 8;
export const MIN_RECAP_ABSENCE_MS = 5 * 60 * 1000;

export interface SessionRecapMaterial {
  /** 上次查看之后收口的轮次 */
  records: CompletionSummaryRecord[];
  /** 这些轮次里新增/改动的产物名（去重后） */
  artifactLabels: string[];
  completedTasks: SessionTask[];
  blockedTasks: SessionTask[];
}

export interface SessionRecap {
  text: string;
  /** true = 小模型不可用，走的纯规则拼接 */
  degraded: boolean;
  completedCount: number;
  blockedCount: number;
}

function artifactLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

/**
 * 从两个素材源收集"我不在的时候产出变了什么"。
 *
 * `sinceTimestamp` 之后收口的轮次才算——用户在场看着跑完的轮次不该再追赶一遍。
 */
export function collectRecapMaterial(
  records: CompletionSummaryRecord[],
  tasks: SessionTask[],
  sinceTimestamp: number,
): SessionRecapMaterial | null {
  const fresh = records.filter((record) => record.endedAt > sinceTimestamp);
  if (fresh.length === 0) return null;

  const labels = new Set<string>();
  for (const record of fresh) {
    for (const ref of record.artifactRefs) {
      if (ref.kind === 'artifact' && ref.title) labels.add(ref.title);
      if (ref.kind === 'file' && ref.path) labels.add(artifactLabel(ref.path));
    }
    for (const filePath of record.changedFiles) labels.add(artifactLabel(filePath));
  }

  const touchedTasks = tasks.filter((task) => (task.updatedAt ?? 0) > sinceTimestamp);

  return {
    records: fresh,
    artifactLabels: [...labels],
    completedTasks: touchedTasks.filter((task) => task.status === 'completed'),
    blockedTasks: touchedTasks.filter((task) => task.status === 'blocked'),
  };
}

/**
 * 降级形态：小模型不可用 / 出错时的纯规则拼接。只讲数字和产物名，不讲工具和报错。
 */
export function formatRecapFallback(material: SessionRecapMaterial): string {
  const parts: string[] = [];
  if (material.artifactLabels.length > 0) {
    const shown = material.artifactLabels.slice(0, 3).join('、');
    const rest = material.artifactLabels.length - 3;
    parts.push(rest > 0 ? `更新了 ${shown} 等 ${material.artifactLabels.length} 项产物` : `更新了 ${shown}`);
  }
  if (material.completedTasks.length > 0) parts.push(`${material.completedTasks.length} 项任务完成`);
  if (material.blockedTasks.length > 0) parts.push(`${material.blockedTasks.length} 项任务受阻`);
  if (parts.length === 0) parts.push(`跑完了 ${material.records.length} 轮`);
  return parts.join('，');
}

function buildPrompt(material: SessionRecapMaterial): string {
  const lines = [
    '下面是一个 AI 助手在用户离开期间做出的产出变化。请用一句中文（40 字以内）说明这段时间产出发生了什么。',
    '要求：说产物和结果，不要提工具名、命令、报错原文、文件路径；有受阻事项要自然点出。不要使用“遇到了卡住”这类病句，不要加引号。',
    '',
  ];
  if (material.artifactLabels.length > 0) {
    lines.push(`变化的产物：${material.artifactLabels.slice(0, MAX_ARTIFACTS_IN_PROMPT).join('、')}`);
  }
  if (material.completedTasks.length > 0) {
    lines.push(`已完成：${material.completedTasks.slice(0, MAX_TASKS_IN_PROMPT).map((task) => task.subject).join('；')}`);
  }
  for (const task of material.blockedTasks.slice(0, MAX_TASKS_IN_PROMPT)) {
    // blockedReason 已过 taskReasonLanguage 清洗（机器噪音会被置空），这里只转述人话那部分
    lines.push(`卡住：${task.subject}${task.blockedReason ? `（${task.blockedReason}）` : ''}`);
  }
  return lines.join('\n');
}

/**
 * 生成一句话追赶提示。素材为空返回 null；小模型不可用时返回 degraded 的规则拼接。
 */
export async function buildSessionRecap(
  material: SessionRecapMaterial,
): Promise<SessionRecap> {
  const fallback: SessionRecap = {
    text: formatRecapFallback(material),
    degraded: true,
    completedCount: material.completedTasks.length,
    blockedCount: material.blockedTasks.length,
  };

  try {
    const { quickTask, isQuickModelAvailable } = await import('../model/quickModel');
    if (!isQuickModelAvailable()) return fallback;

    const result = await quickTask(buildPrompt(material));
    const text = result.success ? (result.content ?? '').trim().replace(/^["'「『]|["'」』]$/g, '') : '';
    if (text.length < 4) return fallback;

    return {
      text: text.length > MAX_RECAP_LENGTH ? `${text.slice(0, MAX_RECAP_LENGTH)}…` : text,
      degraded: false,
      completedCount: material.completedTasks.length,
      blockedCount: material.blockedTasks.length,
    };
  } catch (error) {
    logger.debug('recap quick model unavailable, falling back to rules', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/**
 * IPC 入口用的一把梭：读两个素材源 → 有变化才生成。
 */
export async function getSessionRecap(
  sessionId: string,
  sinceTimestamp: number,
): Promise<SessionRecap | null> {
  if (sinceTimestamp > 0 && Date.now() - sinceTimestamp < MIN_RECAP_ABSENCE_MS) {
    return null;
  }
  const records = await readCompletionSummaryRecordsBySession(sessionId);
  const { listTasks } = await import('../services/planning/taskStore');
  const material = collectRecapMaterial(records, listTasks(sessionId), sinceTimestamp);
  if (!material) return null;
  return buildSessionRecap(material);
}
