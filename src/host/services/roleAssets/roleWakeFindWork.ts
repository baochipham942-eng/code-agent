// ============================================================================
// RoleWakeFindWork — cadence 醒来的「外部增量」巡检与一键工作提议
//
// 履历没有产物时不再静默：用户连了数据源（mail / calendar 等）就改为巡检
// 外部增量（新邮件 / 未来 7 天日程冲突 / 发出超过 STALE_REPLY_DAYS 天没回复的
// 冷线索），让模型给出至多 MAX_PROPOSALS 条 {title,prompt} 提议，原子落盘到
// roles/<roleId>/wake-proposals.json。卡片点击 = 以 prompt 在专家会话开一轮
// 对话（发送/写日历仍走审批）；「先不」= PROPOSAL_DISMISS_DAYS 天内不再重复。
// 发送类工具在 resolveWakeRunToolScope 已排除，这里只约定只读巡检。
// ============================================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../infra/logger';
import { ROLE_PROACTIVITY } from '../../../shared/constants';
import type { RoleProactivityConfig, RoleWakeDecision, RoleWakeProposal } from '../../../shared/contract/roleAssets';
import { getRoleWakeProposalsPath, isSafeRoleId } from './roleAssetPaths';
import { listConnectedSourceNames } from './roleFirstWake';
import { topicExcludeHits } from './wakeRationale';

const logger = createLogger('RoleWakeFindWork');

/** 提议块标记：模型在回复末尾用 ```wake_proposals JSON 围栏给出提议。 */
const PROPOSALS_BLOCK_PATTERN = /```wake_proposals\s*([\s\S]*?)```/i;
const TITLE_MAX_CHARS = 80;
const PROMPT_MAX_CHARS = 500;

/** wake-proposals.json 落盘形状（dismissed 名单是 host 私有，不出 IPC）。 */
interface WakeProposalsState {
  proposals: Array<{ title: string; prompt: string; createdAt: string }>;
  dismissed: Array<{ title: string; dismissedAt: string }>;
}

// ----------------------------------------------------------------------------
// 提示词段
// ----------------------------------------------------------------------------

interface WakeExternalDeltaInput {
  /** 已连接源名（mail / calendar …），逐个点名让模型去查。 */
  sourceNames: readonly string[];
  /** 履历里有没有产物条目：没有 → 开场改为「巡检外部源」；有 → 顺带巡检。 */
  hasProducts: boolean;
  /** 上次醒来日期（履历行解析出的 yyyy-mm-dd；首次没有）。 */
  lastWakeDate?: string;
  /** 已在用户面前的提议标题（pending + 搁置期内 dismissed），模型不得重复。 */
  avoidTitles: readonly string[];
  config?: RoleProactivityConfig;
}

/** 外部增量巡检段：接在四选一提示词的预算行之后（经 resolveWakeExternalDelta 进 prompt）。 */
function buildWakeExternalDeltaSection(input: WakeExternalDeltaInput): string {
  const lines = [
    input.hasProducts
      ? '外部数据源巡检（用户已连接以下源，用只读工具逐项检查，与产物巡检并行）：'
      : '你的履历里还没有经手过的产物。这次改为巡检用户已连接的外部数据源（用只读工具逐项检查）：',
    `- 已连接源：${input.sourceNames.join('、')}`,
    input.lastWakeDate
      ? `- 上次醒来：${input.lastWakeDate}（重点看此后新到的东西）`
      : '- 上次醒来：无记录（看近期情况即可）',
    '- 日程冲突：未来 7 天日历里时间上重叠或安排有问题的日程',
    `- 冷线索：已发出超过 ${ROLE_PROACTIVITY.STALE_REPLY_DAYS} 天还没有收到回复的邮件`,
    '读取规则：某个源读不出来时，必须在回复中点名「未读取：<源名>」，不许静默跳过，更不许编造它的内容。',
  ];
  if (input.avoidTitles.length > 0) {
    lines.push(`- 不要重复提议：以下提议已经出现在用户面前（待处理或被搁置），换个切入点：${input.avoidTitles.map((t) => `「${t}」`).join('')}`);
  }
  lines.push(
    '',
    `从查到的情况里挑出最多 ${ROLE_PROACTIVITY.MAX_PROPOSALS} 件现在值得动手的工作，放在回复末尾：`,
    '```wake_proposals',
    '[{"title":"一句话标题","prompt":"以第一人称写给自己的一条委托：从起草或拟定计划开始，绝不能直接发送或改写外部数据"}]',
    '```',
    '提议规则：prompt 只做起草 / 拟计划 / 整理草稿；真正发送邮件或改写日历永远要等用户在会话里确认。',
  );
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// 解析与落盘
// ----------------------------------------------------------------------------

/** 解析提议块：坏 JSON / 无围栏 / 非数组 → 空表（不重试不重发）；按 avoidTitles 与排除话题过滤。 */
function parseWakeProposals(input: {
  finalOutput: string;
  avoidTitles: readonly string[];
  config?: RoleProactivityConfig;
}): Array<{ title: string; prompt: string }> {
  const block = input.finalOutput.match(PROPOSALS_BLOCK_PATTERN)?.[1];
  if (!block?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set(input.avoidTitles.map((t) => t.trim()));
  const proposals: Array<{ title: string; prompt: string }> = [];
  for (const item of parsed) {
    if (proposals.length >= ROLE_PROACTIVITY.MAX_PROPOSALS) break;
    if (!item || typeof item !== 'object') continue;
    const title = typeof (item as { title?: unknown }).title === 'string'
      ? (item as { title: string }).title.trim().slice(0, TITLE_MAX_CHARS).trim()
      : '';
    const prompt = typeof (item as { prompt?: unknown }).prompt === 'string'
      ? (item as { prompt: string }).prompt.trim().slice(0, PROMPT_MAX_CHARS).trim()
      : '';
    if (!title || !prompt) continue;
    // 同题不再入库：pending 全部 + 搁置期内的 dismissed 都算「已在用户面前」。
    if (seen.has(title)) continue;
    // 排除话题是硬约束，与四选一决策同一判据。
    if (topicExcludeHits(`${title}\n${prompt}`, input.config?.topicsExclude)) continue;
    seen.add(title);
    proposals.push({ title, prompt });
  }
  return proposals;
}

async function readWakeProposalsState(roleId: string): Promise<WakeProposalsState> {
  try {
    const parsed = JSON.parse(await fs.readFile(getRoleWakeProposalsPath(roleId), 'utf-8')) as Partial<WakeProposalsState>;
    return {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
    };
  } catch {
    return { proposals: [], dismissed: [] };
  }
}

/** 临时文件序号：与首次醒来并发写同一角色时避免 temp 名相撞。 */
let tempFileSeq = 0;

/** 原子写：temp + rename，读方永远看不到半个 JSON（与 first-wake 同款）。 */
async function writeWakeProposalsState(roleId: string, state: WakeProposalsState): Promise<void> {
  const filePath = getRoleWakeProposalsPath(roleId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${++tempFileSeq}`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await fs.rename(tempPath, filePath);
}

/** 去重口径：pending 全部标题 + dismissedAt 在 PROPOSAL_DISMISS_DAYS 天内的标题。 */
function activeAvoidTitles(state: WakeProposalsState, now = new Date()): string[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ROLE_PROACTIVITY.PROPOSAL_DISMISS_DAYS);
  return [
    ...state.proposals.map((p) => p.title),
    ...state.dismissed.filter((d) => new Date(d.dismissedAt) >= cutoff).map((d) => d.title),
  ];
}

// ----------------------------------------------------------------------------
// wakeRole 接线（提示词段解析 + 跑后落盘）
// ----------------------------------------------------------------------------

export interface ResolvedWakeExternalDelta {
  /** 提示词段；无已连接源时缺省（调用方维持原行为）。 */
  section?: string;
  sourceNames: readonly string[];
}

/** cadence 醒来前的外部增量解析：无已连接源 → 只回空表，不产出提示词段。 */
export async function resolveWakeExternalDelta(input: {
  roleId: string;
  hasProducts: boolean;
  lastWakeDate?: string;
  config?: RoleProactivityConfig;
  /** 显式给定源名单（脚本回放/测试注入）；缺省查能力中心。 */
  sourceNames?: readonly string[];
}): Promise<ResolvedWakeExternalDelta> {
  const sourceNames: readonly string[] = input.sourceNames ?? (await listConnectedSourceNames());
  if (sourceNames.length === 0) return { sourceNames };
  const state = await readWakeProposalsState(input.roleId);
  return {
    sourceNames,
    section: buildWakeExternalDeltaSection({
      sourceNames,
      hasProducts: input.hasProducts,
      ...(input.lastWakeDate ? { lastWakeDate: input.lastWakeDate } : {}),
      avoidTitles: activeAvoidTitles(state),
      ...(input.config ? { config: input.config } : {}),
    }),
  };
}

/** 醒来跑完后：解析提议块并落盘（与决策无关；无块/坏块不动现有 pending）。返回入库条数。 */
export async function storeWakeProposalsFromWake(input: {
  roleId: string;
  finalOutput: string;
  config?: RoleProactivityConfig;
}): Promise<number> {
  if (!isSafeRoleId(input.roleId)) return 0;
  const state = await readWakeProposalsState(input.roleId);
  const parsed = parseWakeProposals({
    finalOutput: input.finalOutput,
    avoidTitles: activeAvoidTitles(state),
    ...(input.config ? { config: input.config } : {}),
  });
  if (parsed.length === 0) return 0;
  logger.info('Wake proposals stored', { roleId: input.roleId, stored: parsed.length });
  const createdAt = new Date().toISOString();
  state.proposals = [...state.proposals, ...parsed.map((p) => ({ ...p, createdAt }))]
    .slice(0, ROLE_PROACTIVITY.MAX_PROPOSALS);
  await writeWakeProposalsState(input.roleId, state);
  return parsed.length;
}

/** 履历行（`- yyyy-mm-dd | 主动巡检…`）里解析最近一次醒来日期；没有则 undefined。 */
export function lastWakeDateFromHistory(historyLines: readonly string[]): string | undefined {
  for (const line of [...historyLines].reverse()) {
    if (!line.includes(ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX)) continue;
    const date = line.match(/^-\s(\d{4}-\d{2}-\d{2})\b/)?.[1];
    return date;
  }
  return undefined;
}

/** 外部增量巡检时：所有已连接源都被点名「未读取」→ 纠正 silence 为 report（点名故障，不许静默）。 */
export function correctDecisionForUnreadableSources(input: {
  decision: RoleWakeDecision;
  finalOutput: string;
  sourceNames: readonly string[];
  roleId: string;
}): 'report' | typeof input.decision {
  if (input.decision === 'silence' && allConnectedSourcesUnreadable(input.finalOutput, input.sourceNames)) {
    logger.info('Wake forced to report: all connected sources unreadable', { roleId: input.roleId });
    return 'report';
  }
  return input.decision;
}

function allConnectedSourcesUnreadable(finalOutput: string, sourceNames: readonly string[]): boolean {
  if (sourceNames.length === 0) return false;
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sourceNames.every((name) => new RegExp(`未读取[:：]\\s*${escape(name)}`).test(finalOutput));
}

// ----------------------------------------------------------------------------
// IPC 面（list / accept / dismiss）
// ----------------------------------------------------------------------------

/** pending 提议快照（卡片渲染用；超过 MAX_PROPOSALS 的存量不展示）。 */
export async function listWakeProposals(roleId: string): Promise<RoleWakeProposal[]> {
  if (!isSafeRoleId(roleId)) return [];
  const state = await readWakeProposalsState(roleId);
  return state.proposals.slice(0, ROLE_PROACTIVITY.MAX_PROPOSALS).map((p) => ({
    title: p.title,
    prompt: p.prompt,
    createdAt: p.createdAt,
  }));
}

/** 点卡：返回 prompt 并从 pending 移除（卡片消失；会话内发送仍走审批）。 */
export async function acceptWakeProposal(roleId: string, title: string): Promise<{ prompt: string } | null> {
  const trimmed = title.trim();
  if (!isSafeRoleId(roleId) || !trimmed) return null;
  const state = await readWakeProposalsState(roleId);
  const found = state.proposals.find((p) => p.title === trimmed);
  if (!found) return null;
  state.proposals = state.proposals.filter((p) => p !== found);
  await writeWakeProposalsState(roleId, state);
  return { prompt: found.prompt };
}

/** 「先不」：移出 pending 并记入 dismissed（PROPOSAL_DISMISS_DAYS 天内不再重复出现）。 */
export async function dismissWakeProposal(roleId: string, title: string): Promise<{ success: boolean }> {
  const trimmed = title.trim();
  if (!isSafeRoleId(roleId) || !trimmed) return { success: false };
  const state = await readWakeProposalsState(roleId);
  const found = state.proposals.find((p) => p.title === trimmed);
  if (!found) {
    logger.info('Wake proposal dismiss missed (not pending)', { roleId, title: trimmed });
    return { success: false };
  }
  state.proposals = state.proposals.filter((p) => p !== found);
  state.dismissed.push({ title: found.title, dismissedAt: new Date().toISOString() });
  await writeWakeProposalsState(roleId, state);
  return { success: true };
}
