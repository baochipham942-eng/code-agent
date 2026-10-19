import { describe, it, expect } from 'vitest';
import {
  buildCronAgentActionResult,
  cronAgentRunHasAlert,
  isNotifySuppressedResult,
  normalizeAction,
  readCronAlertReason,
} from '../../../src/host/cron/cronNormalizers';
import { CRON_URGENCY_CRITERIA } from '../../../src/shared/constants';

// A6-1: AgentAction 新增 roleId / libraryProjectId 必须穿过归一化边界（落库/读取往返），
// 否则字段被静默丢弃 → 自动化「以角色身份跑」「归档到项目库」全旁路（deny-list 静默漏字段同族）。
describe('normalizeAction — agent action A6 fields round-trip', () => {
  it('preserves roleId and libraryProjectId when present', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: '写一份周报',
      roleId: 'muzhi',
      libraryProjectId: 'proj_123',
    });
    expect(action).toMatchObject({
      type: 'agent',
      roleId: 'muzhi',
      libraryProjectId: 'proj_123',
    });
  });

  it('leaves both undefined when absent (零扰动现状)', () => {
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x' });
    expect(action).toMatchObject({ type: 'agent', roleId: undefined, libraryProjectId: undefined });
  });

  it('drops non-string values instead of trusting caller shape', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: 'x',
      roleId: 42,
      libraryProjectId: { nested: true },
    });
    expect(action).toMatchObject({ roleId: undefined, libraryProjectId: undefined });
  });
});

// N-CLOUD-ROLE-WAKE-PROTO r1: RoleWakeAction 新增的 environmentId 同样必须穿过归一化边界，
// 否则 DB 重载重建定义时字段被剥掉 → 重启后云端 reconcile 重声明恒缺 environmentId，
// 被误拒为 missing-environment-id（创建时在、重启后没，A6-1 同族）。
describe('normalizeAction — role-wake environmentId round-trip', () => {
  it('preserves environmentId when present', () => {
    const action = normalizeAction({
      type: 'role-wake',
      roleId: 'role-analyst',
      environmentId: 'env-prod',
    });
    expect(action).toMatchObject({
      type: 'role-wake',
      roleId: 'role-analyst',
      environmentId: 'env-prod',
    });
  });

  it('leaves environmentId undefined when absent (零扰动本地醒来行为)', () => {
    const action = normalizeAction({ type: 'role-wake', roleId: 'role-analyst' });
    expect(action).toMatchObject({ type: 'role-wake', roleId: 'role-analyst', environmentId: undefined });
  });

  it('drops non-string values instead of trusting caller shape', () => {
    const action = normalizeAction({ type: 'role-wake', roleId: 'role-analyst', environmentId: 42 });
    expect(action).toMatchObject({ environmentId: undefined });
  });
});

// N-CRON-MORNING-TRIAGE-URGENCY-RULE: urgencyCriteria 同样必须穿过归一化边界，
// 否则用户写的紧急判据存得进、读不出，prompt 静默退回内置定义。
describe('normalizeAction — urgencyCriteria round-trip', () => {
  it('preserves a trimmed criterion when present', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: '晨间分诊',
      urgencyCriteria: '  只有老板发来的邮件算今天必须处理  ',
    });
    expect(action).toMatchObject({ urgencyCriteria: '只有老板发来的邮件算今天必须处理' });
  });

  it('drops non-string and blank values (undefined)', () => {
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: '   ' }))
      .toMatchObject({ urgencyCriteria: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: 42 }))
      .toMatchObject({ urgencyCriteria: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x' }))
      .toMatchObject({ urgencyCriteria: undefined });
  });

  it('truncates over-length input to CRON_URGENCY_CRITERIA.MAX_CHARS instead of rejecting the action', () => {
    const over = 'a'.repeat(CRON_URGENCY_CRITERIA.MAX_CHARS + 10);
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: over });
    expect(action?.type).toBe('agent');
    if (action?.type !== 'agent') throw new Error('expected an agent action');
    expect(action.urgencyCriteria).toHaveLength(CRON_URGENCY_CRITERIA.MAX_CHARS);
    expect(action.urgencyCriteria).toBe('a'.repeat(CRON_URGENCY_CRITERIA.MAX_CHARS));
  });
});

// N-CRON-RESTATE-HUMAN-WHEN: notifyWhen 与 urgencyCriteria 同款归一化——判据存得进、
// 读不出会让 prompt 注入与通知门同时静默失效（A6-1 同族）。
describe('normalizeAction — notifyWhen round-trip', () => {
  it('preserves a trimmed rule when present', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: '晨报',
      notifyWhen: '  只有出现紧急事项才通知我  ',
    });
    expect(action).toMatchObject({ notifyWhen: '只有出现紧急事项才通知我' });
  });

  it('drops non-string and blank values (undefined = 每次都通知的旧行为)', () => {
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', notifyWhen: '   ' }))
      .toMatchObject({ notifyWhen: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', notifyWhen: ['urgent'] }))
      .toMatchObject({ notifyWhen: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x' }))
      .toMatchObject({ notifyWhen: undefined });
  });

  it('truncates over-length input to the same CRON_URGENCY_CRITERIA.MAX_CHARS cap', () => {
    const over = '紧'.repeat(CRON_URGENCY_CRITERIA.MAX_CHARS + 5);
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', notifyWhen: over });
    expect(action?.type).toBe('agent');
    if (action?.type !== 'agent') throw new Error('expected an agent action');
    expect(action.notifyWhen).toHaveLength(CRON_URGENCY_CRITERIA.MAX_CHARS);
  });
});

// N-CRON-RESTATE-HUMAN-WHEN: 结果标记组装——notifyQuiet 只打 notifySuppressed，
// 不得顺手打成 skipped（skipped 会让运行不进待过目收件箱，违背「执行留痕」）。
describe('buildCronAgentActionResult — notifySuppressed 标记', () => {
  const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };

  it('marks notifySuppressed only for notify-quiet rounds', () => {
    const quiet = buildCronAgentActionResult(action, undefined, 's1', '正文', false, true);
    expect(quiet).toMatchObject({ notifySuppressed: true });
    expect(quiet).not.toHaveProperty('skipped');
    const loud = buildCronAgentActionResult(action, undefined, 's1', '<cron_alert>出事了</cron_alert>', false, false);
    expect(loud).not.toHaveProperty('notifySuppressed');
    expect(loud).not.toHaveProperty('skipped');
  });

  it('isNotifySuppressedResult 只认带标记的 agent 结果', () => {
    expect(isNotifySuppressedResult(buildCronAgentActionResult(action, undefined, 's1', 'x', false, true))).toBe(true);
    expect(isNotifySuppressedResult(buildCronAgentActionResult(action, undefined, 's1', 'x', false, false))).toBe(false);
    expect(isNotifySuppressedResult(undefined)).toBe(false);
    expect(isNotifySuppressedResult('完成')).toBe(false);
    // skipped（external-watch 安静轮）不带 notifySuppressed：那是另一条静音路径。
    expect(isNotifySuppressedResult(buildCronAgentActionResult(action, undefined, 's1', 'x', true, false))).toBe(false);
  });
});

// N-CRON-RESTATE-HUMAN-WHEN-FU1: notifyWhen 满足轮把 <cron_alert> 一句话原因带进结果，
// 完成系统通知正文直接用它。只有「判据设置 + 非安静轮 + 提取非空」三条件齐了才落键——
// 空标签回落通用文案（通知永不空正文），无 notifyWhen 的任务（含 external-watch）恒无此键。
describe('buildCronAgentActionResult — alertReason 标记', () => {
  const alertText = '今日值班交接中存在紧急事项：生产服务器宕机，需要立即处理';

  it('notifyWhen + alert 正文 → alertReason 为去壳后的内文', () => {
    const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };
    const built = buildCronAgentActionResult(
      action, undefined, 's1', `例行内容\n<cron_alert>  ${alertText}  </cron_alert>`, false, false,
    );
    expect(built.alertReason).toBe(alertText);
  });

  it('notifyWhen 但正文无 alert → 不落 alertReason 键（安静轮另有 notifySuppressed）', () => {
    const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };
    const built = buildCronAgentActionResult(action, undefined, 's1', '例行内容', false, false);
    expect(built).not.toHaveProperty('alertReason');
  });

  it('notifyWhen + 空 alert 标签 → 不落 alertReason 键（通知回落通用文案）', () => {
    const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };
    const built = buildCronAgentActionResult(action, undefined, 's1', '<cron_alert></cron_alert>', false, false);
    expect(built).not.toHaveProperty('alertReason');
  });

  it('无 notifyWhen 的任务正文带 alert 也不落键（external-watch 通知保持通用文案）', () => {
    const action = { agentType: 'default', prompt: 'p' };
    const built = buildCronAgentActionResult(
      action, undefined, 's1', `<cron_alert>${alertText}</cron_alert>`, false, false,
    );
    expect(built).not.toHaveProperty('alertReason');
  });

  it('notifyQuietRound 优先于提取：安静轮即使正文有 alert 也不落键', () => {
    const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };
    const built = buildCronAgentActionResult(
      action, undefined, 's1', `<cron_alert>${alertText}</cron_alert>`, false, true,
    );
    expect(built).not.toHaveProperty('alertReason');
    expect(built).toMatchObject({ notifySuppressed: true });
  });
});

// 完成通知读原因的唯一入口：非 agent 形状（云端 summary、shell 结果、字符串）与
// 缺席/空串都回 undefined——通知层拿 undefined 才会回落通用文案。
describe('readCronAlertReason 守卫读取', () => {
  it('returns the reason for a built agent result', () => {
    const action = { agentType: 'default', prompt: 'p', notifyWhen: '紧急才通知' };
    const built = buildCronAgentActionResult(
      action, undefined, 's1', '<cron_alert>出事了</cron_alert>', false, false,
    );
    expect(readCronAlertReason(built)).toBe('出事了');
  });

  it('tolerates non-agent-shaped results and blank reasons', () => {
    expect(readCronAlertReason(undefined)).toBeUndefined();
    expect(readCronAlertReason('云端 summary 字符串')).toBeUndefined();
    expect(readCronAlertReason({ status: 200, body: 'shell 结果' })).toBeUndefined();
    expect(readCronAlertReason({ sessionId: 's1' })).toBeUndefined();
    expect(readCronAlertReason({ sessionId: 's1', alertReason: '  ' })).toBeUndefined();
    expect(readCronAlertReason({ sessionId: 's1', alertReason: 42 })).toBeUndefined();
  });
});

// ============================================================================
// cronAgentRunHasAlert — 成功运行「值得打扰」矩阵（N-CRON-URGENCY-NOTIFY）。
// 原 cronService 内联三元收口至此：gated（external-watch / notifyWhen）任务只认
// <cron_alert>；仅设 urgencyCriteria 的任务只认结果显式声明的 can_wait/fyi 头
// （must_today/缺头/乱头都响）；什么判据都没设恒响（每轮照常通知）。
// ============================================================================
describe('cronAgentRunHasAlert — 值得打扰矩阵', () => {
  const quiet = 'urgency: can_wait\n一切照旧';
  const must = 'urgency: must_today\n老板来信';

  it('无任何判据：任何结果（含 can_wait 头）都响（无判据任务行为零变化）', () => {
    expect(cronAgentRunHasAlert({}, { isExternalWatch: false, finalAssistantText: quiet })).toBe(true);
    expect(cronAgentRunHasAlert({}, { isExternalWatch: false, finalAssistantText: must })).toBe(true);
  });

  it('notifyWhen 判据：只认 <cron_alert>（N-CRON-RESTATE-HUMAN-WHEN 行为零变化）', () => {
    const action = { notifyWhen: '只有紧急事项' };
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: '<cron_alert>紧急</cron_alert>' })).toBe(true);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: must })).toBe(false);
  });

  it('仅 urgencyCriteria：显式 can_wait/fyi 不响；must_today/缺头/乱头照响', () => {
    const action = { urgencyCriteria: '只有老板发来的邮件算今天必须处理' };
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: quiet })).toBe(false);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: 'urgency: fyi\n天气速览' })).toBe(false);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: must })).toBe(true);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: '普通正文没有头部行' })).toBe(true);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: 'urgency: maybe\n正文' })).toBe(true);
  });

  it('档位头与 buildCronAgentActionResult 的 urgency 解析同源：优先读 <cron_summary> 摘要', () => {
    const action = { urgencyCriteria: '只有老板发来的邮件算今天必须处理' };
    // 摘要块首行 can_wait → 安静（正文里的 must_today 字样不参与）
    const summaryQuiet = 'urgency: must_today\n<cron_summary>\nurgency: can_wait\n周报照旧\n</cron_summary>';
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: summaryQuiet })).toBe(false);
    // 有摘要块但档位头只写在正文（不在摘要里）→ 不算声明，照常响
    const headOutsideSummary = 'urgency: can_wait\n<cron_summary>\n周报照旧\n</cron_summary>';
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: headOutsideSummary })).toBe(true);
    // 无摘要块时读正文头部
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: quiet })).toBe(false);
  });

  it('notifyWhen + urgencyCriteria 同设：notifyWhen 独自决定，urgency 头不参与', () => {
    const action = { urgencyCriteria: '只有老板发来的邮件算今天必须处理', notifyWhen: '只有紧急事项' };
    // 有 alert 标记 → 响（即使档位是 must_today 或 can_wait 都无所谓）
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: `${must}\n<cron_alert>紧急</cron_alert>` })).toBe(true);
    // 无 alert 标记 → 安静（即使正文显式 can_wait）
    expect(cronAgentRunHasAlert(action, { isExternalWatch: false, finalAssistantText: quiet })).toBe(false);
  });

  it('external-watch：只认 <cron_alert>，urgency 规则对监听任务不生效', () => {
    const action = { urgencyCriteria: '只有老板发来的邮件算今天必须处理' };
    expect(cronAgentRunHasAlert(action, { isExternalWatch: true, finalAssistantText: '<cron_alert>日历新冲突</cron_alert>' })).toBe(true);
    expect(cronAgentRunHasAlert(action, { isExternalWatch: true, finalAssistantText: quiet })).toBe(false);
  });

  it('空白判据视为未设置（与 normalizeCriteriaSentence 的 trim 语义一致）', () => {
    expect(cronAgentRunHasAlert({ urgencyCriteria: '   ' }, { isExternalWatch: false, finalAssistantText: quiet })).toBe(true);
    expect(cronAgentRunHasAlert({ notifyWhen: '   ' }, { isExternalWatch: false, finalAssistantText: '普通正文' })).toBe(true);
  });
});
