// ============================================================================
// savedRoutineRestate —— 保存成功后的「会这样做」三行复述（N-ROLE-ROUTINE-RESTATE）。
// 纯函数：输入是保存成功的 CronJobDefinition + 角色显示名 + 已解析的通道标签，
// 输出 what/when/result 三行，确定性、零模型调用。what/when 复用聊天侧
// buildScheduleConfirmRows 的口径（#2414 的人话 when）；event 调度换成固定句子；
// result 永不透出原始 "<账号>:<会话id>" 串。
// ============================================================================

import type { CronJobDefinition } from '@shared/contract';
import type { ChannelAccount } from '@shared/contract/channel';
import type { CronHumanLang } from '@shared/cronHumanize';
import { buildScheduleConfirmRows } from '../chat/ChatInput/scheduleConfirm';
import { findTargetAccount, parseResultTarget } from './CronResultChannel';

/** 通道目录的最小结构（useChannelCatalog 的返回值可直接喂进来）。 */
export interface SavedRoutineChannelCatalog {
  accounts: ChannelAccount[];
  conversationsByAccount: Record<string, { conversations?: readonly { id: string; name: string }[] }>;
}

/**
 * resultChannel（"<账号名或类型>:<会话id>"）→ 展示标签。未设置给空串（由调用方
 * 落到「自动化审核收件箱」）；目录命中账号时账号名 + 已知会话标题，会话不在目录
 * 就只给账号名；账号已不在（unknown account）也给账号名一段，绝不拼出原始串。
 */
export function resolveSavedRoutineChannelLabel(
  resultChannel: string,
  catalog: SavedRoutineChannelCatalog,
): string {
  const parsed = parseResultTarget(resultChannel);
  if (!parsed) return resultChannel.trim();
  const account = findTargetAccount(catalog.accounts, parsed.accountKey);
  if (!account) return parsed.accountKey;
  const conversation = catalog.conversationsByAccount[account.id]?.conversations
    ?.find((item) => item.id === parsed.conversationId);
  return conversation ? `${account.name} · ${conversation.name}` : account.name;
}

interface SavedRoutineRestateLabels {
  /** 复用 scheduleConfirm 的行标签与兜底（what/when/result/fallbackWhat/reviewInbox）。 */
  what: string;
  when: string;
  result: string;
  fallbackWhat: string;
  reviewInbox: string;
  /** cronCenter 新增：event 调度固定句子（如「有新消息到达时」）。 */
  savedWhenEvent: string;
  /** cronCenter 新增：what 行角色前缀模板，如「由 {role} 执行：」。 */
  savedRolePrefix: string;
  /** cronCenter 新增：停用状态行的标签与值（仅 job.enabled === false 时出第四行）。 */
  savedStatusLabel: string;
  savedStatusPaused: string;
}

export interface SavedRoutineRestateInput {
  job: CronJobDefinition;
  /** 角色显示名（listRoles 的 displayName；调用方负责回落 roleId）。 */
  roleDisplayName: string;
  /** 已解析的结果通道标签；空串 = 未设置。 */
  channelLabel: string;
  labels: SavedRoutineRestateLabels;
  lang?: CronHumanLang;
}

export interface SavedRoutineRow {
  key: 'what' | 'when' | 'result' | 'status';
  label: string;
  value: string;
}

export function buildSavedRoutineRestateRows(input: SavedRoutineRestateInput): readonly SavedRoutineRow[] {
  const { job, roleDisplayName, channelLabel, labels, lang = 'zh' } = input;
  // what/when 复用聊天侧确认卡口径：保存后的定义是 create 输入的超集，结构字段一致。
  // notifyWhen 行不在本单范围，丢弃；result 行的值是原始 resultChannel，也丢弃。
  const confirmRows = buildScheduleConfirmRows(
    { input: job, restatement: undefined },
    {
      what: labels.what,
      when: labels.when,
      notifyWhen: '',
      result: labels.result,
      fallbackWhat: labels.fallbackWhat,
      fallbackNotifyWhen: '',
      reviewInbox: labels.reviewInbox,
    },
    lang,
  );
  // what 的底文优先用保存记录里的完整目标（agent prompt）：简易创建在用户没起名时拿
  // goal 前 48 字当任务名（buildSimpleDraft 的 name 兜底），what 若跟 name 走，长目标
  // 会被截在词中间（rework r1 实录：en 目标复述止于 "turn th"）。goal 才是复述语义源；
  // role-wake 没有 prompt、prompt 空白时回落 buildScheduleConfirmRows 的既有口径
  // （name / 动作描述 / 兜底）。
  const savedGoal = job.action.type === 'agent' ? job.action.prompt.trim() : '';
  const baseWhat = savedGoal
    || confirmRows.find((row) => row.key === 'what')?.value
    || labels.fallbackWhat;
  const roleName = roleDisplayName.trim();
  const what = roleName
    ? `${labels.savedRolePrefix.replace('{role}', roleName)}${baseWhat}`
    : baseWhat;
  // event 调度没有下一次时间（无 croner、无 nextRunAt）：给固定句子，绝不留空行。
  const when = job.schedule?.type === 'event'
    ? labels.savedWhenEvent
    : (confirmRows.find((row) => row.key === 'when')?.value ?? '');
  const result = channelLabel.trim() || labels.reviewInbox;
  // 停用副本（copy-to-cloud 一律 enabled:false）追加第四行「状态」：用户读着
  // 「每天 09:00」会以为它会跑，其实要按了启用才会（N-ROLE-ROUTINE-RESTATE-FU1-FU1）。
  const rows: SavedRoutineRow[] = [
    { key: 'what', label: labels.what, value: what },
    { key: 'when', label: labels.when, value: when },
    { key: 'result', label: labels.result, value: result },
  ];
  if (job.enabled === false) {
    rows.push({ key: 'status', label: labels.savedStatusLabel, value: labels.savedStatusPaused });
  }
  return rows;
}
