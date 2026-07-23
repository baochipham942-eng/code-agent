// ============================================================================
// Role Proactivity — 角色主动性（cadence 触发器 + 醒来循环）
// ============================================================================
//
// 设计：内部文档
//
// 核心循环（§3 八步）：
//   预算检查 → 实例化（带记忆）→ 创建会话 → 跑实例 → 解析四选一决策
//   → 沉默归档/非沉默推送 → 写回履历 → 实例销毁
//
// 两个触发入口共用本循环：
//   - cadence：cron 到点（role-wake action → wakeRole(roleId, 'cadence')）
//   - event：长任务跑完（Stop hook 链路 → wakeRole(roleId, 'event')）
// ============================================================================

import { createLogger } from '../infra/logger';
import {
  evaluateNotificationPolicy,
  sanitizeNotificationText,
} from '../infra/notificationPolicy';
import { ROLE_PROACTIVITY, SWARM_GOAL } from '../../../shared/constants';
import type {
  RoleProactivityConfig,
  RoleProactivityLevel,
  RoleWakeDecision,
  RoleWakeResult,
  RoleWakeTrigger,
} from '../../../shared/contract/roleAssets';
import { instantiateRole, appendRoleHistory, loadRoleHistory, listPersistentRoles, isPersistentRole } from './roleAssetService';
import { runRoleWriteBack } from './roleWriteBack';
import { getSessionAutomationService } from '../sessionAutomation';
import type { SessionAutomationEventKind, SessionAutomationStatus } from '../../../shared/contract/sessionAutomation';

const logger = createLogger('RoleProactivity');

// ----------------------------------------------------------------------------
// 配置解析（设计 §4：settings per-role 覆盖 > 角色 frontmatter > 全局默认）
// ----------------------------------------------------------------------------

/**
 * 解析一个角色的主动性配置。
 * 优先级：settings.roleAssets.proactivity.roles[roleId]（用户改的）
 *       > 角色 frontmatter proactivity-level / proactivity-cadence（角色定义自带）
 *       > settings.roleAssets.proactivity.defaultLevel（用户全局默认）
 *       > ROLE_PROACTIVITY.DEFAULT_LEVEL（常量兜底）
 */
export async function resolveRoleProactivityConfig(roleId: string): Promise<RoleProactivityConfig> {
  // 1) settings per-role 覆盖
  let settingsDefault: RoleProactivityLevel | undefined;
  try {
    const { getConfigService } = await import('../core/configService');
    const proactivitySettings = getConfigService().getSettings().roleAssets?.proactivity;
    const override = proactivitySettings?.roles?.[roleId];
    // 整份配置一起走这条优先级链，quietHours 不另开旁路。
    if (override) return override;
    settingsDefault = proactivitySettings?.defaultLevel;
  } catch {
    // ConfigService 未初始化（测试场景）→ 走后续层级
  }

  // 2) 角色 frontmatter（agent 定义；RegisteredAgent extends CoreAgentConfig）
  try {
    const { resolveAgent } = await import('../../agent/agentRegistry');
    const agent = resolveAgent(roleId);
    if (agent?.proactivity) return agent.proactivity;
  } catch {
    // registry 未初始化 → 走默认
  }

  // 3) 全局默认
  const level = settingsDefault ?? (ROLE_PROACTIVITY.DEFAULT_LEVEL as RoleProactivityLevel);
  return { level };
}

/** 等级对应的默认 cron 表达式（realtime 没自定义时也用每日，靠用户填 cadence 提频） */
export function cadenceForConfig(config: RoleProactivityConfig): string | null {
  if (config.level === 'silent') return null;
  return config.cadence || ROLE_PROACTIVITY.DAILY_BRIEF_CRON;
}

function minutesSinceMidnight(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * 判断本地时间是否落在免打扰时段内。
 * start 为闭区间，end 为开区间；start === end 视为空时段。
 */
export function isWithinQuietHours(
  now: Date,
  quietHours: RoleProactivityConfig['quietHours'],
): boolean {
  if (!quietHours) return false;
  const start = minutesSinceMidnight(quietHours.start);
  const end = minutesSinceMidnight(quietHours.end);
  if (start === null || end === null || start === end) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

// ----------------------------------------------------------------------------
// 预算护栏（设计 §6：每角色每天最多醒 N 次，cadence + event 合计）
// ----------------------------------------------------------------------------

/** 履历中醒来条目的产物标签（按它统计当天醒来次数） */
function wakeHistoryLabel(trigger: RoleWakeTrigger): string {
  return `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}(${trigger})`;
}

/** 统计角色当天已醒来的次数（从履历统计，跨重启持久） */
export async function countWakesToday(roleId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  // 取全量履历里今天的醒来条目（loadRoleHistory 默认只取最近 N 条，这里取大窗口确保覆盖当天）
  const entries = await loadRoleHistory(roleId, ROLE_PROACTIVITY.MAX_WAKES_PER_DAY * 10);
  return entries.filter(
    (line) => line.startsWith(`- ${today} `) && line.includes(ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX),
  ).length;
}

// ----------------------------------------------------------------------------
// 醒来 prompt（设计 §3.1）
// ----------------------------------------------------------------------------

function buildWakePrompt(trigger: RoleWakeTrigger, extraContext?: string): string {
  const lines = [
    `你被${trigger === 'cadence' ? '定时' : '任务结束事件'}唤醒。这不是用户发来的消息，用户现在不在。`,
    '',
    '你的任务：',
    '1. 读你的工作履历（上面角色资产注入块里），找出你经手过的产物',
    '2. 逐个检查这些产物的现状（文件还在吗、内容有没有需要跟进的）',
    '3. 四选一决策并执行：',
    '   - 【推进 advance】产物有明确的下一步：',
    '       · 履历或产物里出现 TODO、未完成待办、"下一步需要"、可验证的本地修复/创建/修改动作时，必须选择 advance',
    '       · 一步就能做完 → 直接做，做完汇报',
    '       · 需要多步推进（修复+验证、重构+测试等）→ 不要自己零散地做，改为给出一个目标提案，',
    '         系统会为它发起一个带完成判定的正式 goal run（干完必须过验证闸才算数）：',
    '           <goal>用一句话写清要达成什么</goal>',
    '           <verify>验收用的 shell 命令，退出码 0 即达成（能写就写，写不出可省略）</verify>',
    '   - 【汇报 report】发现了值得用户知道的变化/问题 → 写简报',
    '   - 【建议 suggest】有改进想法但需要用户拍板 → 列出建议',
    '   - 【沉默 silence】检查完没有值得说的 → 直接结束（沉默是合法结果，不要为了显得有用而硬找话说）',
    `4. 回复末尾必须带决策标记，格式：<decision>advance</decision> 或 <decision>report</decision> 或 <decision>suggest</decision> 或 <decision>silence</decision>`,
    '',
    `预算约束：你最多有 ${ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS} 轮工具调用，超出会被强制结束，重要的事先做。`,
  ];
  if (extraContext) {
    lines.push('', '本次唤醒的额外上下文：', extraContext);
  }
  return lines.join('\n');
}

/** 从醒来产出解析四选一决策（提取不到时保守兜底为"汇报"，设计 §3.2） */
export function parseWakeDecision(finalOutput: string): RoleWakeDecision {
  const match = finalOutput.match(ROLE_PROACTIVITY.DECISION_TAG_PATTERN);
  if (match) {
    return match[1].toLowerCase() as RoleWakeDecision;
  }
  return ROLE_PROACTIVITY.FALLBACK_DECISION as RoleWakeDecision;
}

/** advance 多步推进时模型给出的 goal 提案（内部文档 §3.2） */
export interface AdvanceGoalProposal {
  goal: string;
  /** 可选的闸1 验证命令；缺省时把 goal 文本作为闸2 软评审条件 */
  verify?: string;
}

/**
 * 从 advance 醒来产出解析 goal 提案。
 * 有 <goal> 标记 → 返回提案（含可选 <verify>）；无 → 返回 null（按普通 advance 处理，不发起 goal run）。
 */
export function parseAdvanceGoalProposal(finalOutput: string): AdvanceGoalProposal | null {
  const goalMatch = finalOutput.match(SWARM_GOAL.GOAL_TAG_PATTERN);
  const goal = goalMatch?.[1]?.trim();
  if (!goal) return null;
  const verifyMatch = finalOutput.match(SWARM_GOAL.VERIFY_TAG_PATTERN);
  const verify = verifyMatch?.[1]?.trim();
  return verify ? { goal, verify } : { goal };
}

const ADVANCE_SIGNAL_PATTERN = /(?:TODO|待办|未完成|下一步(?:需要|要)|还没做|尚未|待处理|待推进|未验证|verify|test\s+-f)/i;
const VERIFY_COMMAND_PATTERN = /(?:^|[\s，。；;])((?:test\s+-f\s+(?:"[^"]+"|'[^']+'|[^\s，。；;]+))|(?:npx\s+vitest\s+run[^\n，。；;]*)|(?:npm\s+(?:run\s+)?test[^\n，。；;]*)|(?:pnpm\s+test[^\n，。；;]*)|(?:yarn\s+test[^\n，。；;]*))/im;

function cleanInferredText(text: string): string {
  return text
    .replace(/^[\s\-*[\]\d.)]+/, '')
    .replace(/^下一步(?:需要|要)[:：]?\s*/, '')
    .replace(/^目标是[:：]?\s*/, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();
}

function inferVerifyCommand(text: string): string | undefined {
  const command = text.match(VERIFY_COMMAND_PATTERN)?.[1]?.trim();
  return command ? cleanInferredText(command) : undefined;
}

function inferGoalText(text: string, verify?: string): string {
  const explicitGoal = text.match(/(?:目标是|下一步(?:需要|要))[:：]?\s*([^\n。]+)/)?.[1];
  if (explicitGoal) return cleanInferredText(explicitGoal);

  const todoLine = text
    .split('\n')
    .map((line) => cleanInferredText(line))
    .find((line) => ADVANCE_SIGNAL_PATTERN.test(line) && line.length > 0 && !line.includes(ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX));
  if (todoLine) return todoLine.slice(0, 160);

  const changedFile = text.match(/(?:创建|生成|写入|修改)\s+([A-Za-z0-9_.-]+\.(?:md|txt|json|tsx?|jsx?|html|css|xlsx?|pptx?))/)?.[1];
  if (changedFile && verify) return `完成 ${changedFile} 并通过 ${verify} 验证`;
  if (verify) return `完成履历中的未完成待办，并通过 ${verify} 验证`;
  return '推进履历中的未完成待办';
}

/**
 * 模型偶尔会把明确的可验证下一步误标为 report。这里只在产出/角色资产里出现
 * 强推进信号时做确定性兜底，避免把普通巡检简报伪装成 advance。
 */
export function inferAdvanceGoalProposalFromWake(finalOutput: string, contextBlock?: string | null): AdvanceGoalProposal | null {
  const explicitProposal = parseAdvanceGoalProposal(finalOutput);
  if (explicitProposal) return explicitProposal;
  const source = [finalOutput, contextBlock ?? ''].filter((s) => s.trim().length > 0).join('\n');
  if (!ADVANCE_SIGNAL_PATTERN.test(source)) return null;
  const verify = inferVerifyCommand(source);
  const goal = inferGoalText(source, verify);
  return verify ? { goal, verify } : { goal };
}

// ----------------------------------------------------------------------------
// 醒来循环（设计 §3）
// ----------------------------------------------------------------------------

export interface WakeRoleOptions {
  /** event 触发时的来源会话（长任务所在会话） */
  sourceSessionId?: string;
  /** event 触发时传入的 run 产出摘要（角色总结 + next steps 的输入） */
  runSummary?: string;
  /** 角色醒来完成后发回来源会话并触发下一步的显式交接提示词 */
  handoffPrompt?: string;
  /** 工作目录（项目记忆 key）；不传用当前会话的 */
  workspacePath?: string;
}

/**
 * 角色醒来完整循环。
 * 返回 RoleWakeResult（cron 执行记录 / E2E 验收用），不向上抛业务异常
 * （基础设施异常如 orchestrator 不可用仍会抛，让 cron 执行记录标 failed）。
 */
export async function wakeRole(
  roleId: string,
  trigger: RoleWakeTrigger,
  options?: WakeRoleOptions,
): Promise<RoleWakeResult> {
  // ---- 步骤 0：持久化角色门槛 ----
  // 必须最先检查：cron job 可能指向已删除的角色，后续守卫（空产物静默）会写履历，
  // 对已删除角色写履历等于把它的目录重新创建出来（单测实测踩坑）。
  if (!(await isPersistentRole(roleId))) {
    throw new Error(`Role "${roleId}" is not a persistent role (no roles/${roleId}/ directory); cannot wake it via ${trigger}`);
  }

  // ---- 步骤 0.5：等级检查（silent 档不醒）----
  const config = await resolveRoleProactivityConfig(roleId);
  if (config.level === 'silent') {
    logger.info('Wake skipped: role is silent', { roleId, trigger });
    return { roleId, trigger, status: 'skipped', skipReason: 'silent_level' };
  }

  // ---- 步骤 1：预算检查（设计 §6）----
  const wakesToday = await countWakesToday(roleId);
  if (wakesToday >= ROLE_PROACTIVITY.MAX_WAKES_PER_DAY) {
    logger.warn('Wake skipped: daily budget exceeded', { roleId, trigger, wakesToday });
    return {
      roleId,
      trigger,
      status: 'skipped',
      skipReason: `daily_budget_exceeded (${wakesToday}/${ROLE_PROACTIVITY.MAX_WAKES_PER_DAY})`,
    };
  }

  // ---- 步骤 1.5：免打扰时段（本次丢弃，不顺延）----
  if (isWithinQuietHours(new Date(), config.quietHours)) {
    logger.info('Wake skipped: within quiet hours', {
      roleId,
      trigger,
      quietHours: config.quietHours,
    });
    return { roleId, trigger, status: 'skipped', skipReason: 'quiet_hours' };
  }

  // ---- 步骤 2：空产物守卫（成本闸）----
  // cadence 醒来的输入是"自己经手过的产物"；履历里没有任何产物条目（排除醒来记录本身）
  // 就没有东西可巡检，确定性静默，不烧模型 token。event 触发不受此限（run 总结的输入是 runSummary）。
  if (trigger === 'cadence') {
    const allHistory = await loadRoleHistory(roleId, Number.MAX_SAFE_INTEGER);
    const productEntries = allHistory.filter((l) => !l.includes(ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX));
    if (productEntries.length === 0) {
      logger.info('Wake resolved to silence: no products in history', { roleId, trigger });
      await appendRoleHistory(roleId, {
        date: new Date().toISOString().slice(0, 10),
        artifactLabel: wakeHistoryLabel(trigger),
        artifactRef: '-',
        summary: '巡检无需行动（履历中没有产物）',
      });
      return { roleId, trigger, status: 'completed', decision: 'silence', summary: '履历中没有产物，无需巡检' };
    }
  }

  // ---- 步骤 3：实例化（带记忆；非持久化角色在这里抛错）----
  const { getSessionManager } = await import('../infra/sessionManager');
  const { getConfigService } = await import('../core/configService');
  const { resolveSessionDefaultModelConfig } = await import('../core/sessionDefaults');

  const sessionManager = getSessionManager();
  const configService = getConfigService();
  const settings = configService.getSettings();
  const currentSessionId = sessionManager.getCurrentSessionId();
  const currentSession = currentSessionId ? await sessionManager.getSession(currentSessionId) : null;
  // workspace 解析链（与 webServer/desktop bootstrap 同序）：显式传入 > 当前会话 >
  // CODE_AGENT_WORKING_DIR > 用户工作区偏好。不能落到 process.cwd()——那是应用安装目录，
  // 角色会跑去巡检应用自己的代码（E2E 实测踩坑）。
  const workspacePath = options?.workspacePath
    ?? currentSession?.workingDirectory
    ?? process.env.CODE_AGENT_WORKING_DIR?.trim()
    ?? settings.workspace?.pinnedDirectory
    ?? settings.workspace?.recentDirectories?.[0]
    ?? settings.workspace?.defaultDirectory;

  const instantiation = await instantiateRole(roleId, trigger, {
    task: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（${trigger}）`,
    workspacePath,
  });

  // ---- 步骤 4：创建醒来会话（origin 标记 role-cadence，防 event 递归触发）----
  const now = new Date();
  const titleStamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const session = await sessionManager.createSession({
    title: `${roleId} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX} ${titleStamp}`,
    // 注意：provider/model 不传常量兜底——传 undefined 让 resolver 落到
    // settings.models.defaultProvider（headless webServer 没有 currentSession，
    // 硬传 DEFAULT_PROVIDER 会绕过用户配置的默认 provider）
    modelConfig: resolveSessionDefaultModelConfig({
      provider: settings.model?.provider || currentSession?.modelConfig.provider,
      model: settings.model?.model || currentSession?.modelConfig.model,
      temperature: settings.model?.temperature ?? currentSession?.modelConfig.temperature,
      maxTokens: settings.model?.maxTokens ?? currentSession?.modelConfig.maxTokens,
    }),
    workingDirectory: workspacePath,
    type: 'schedule',
    origin: {
      kind: 'cron',
      name: ROLE_PROACTIVITY.CADENCE_JOB_TAG,
      metadata: { roleId, trigger, sourceSessionId: options?.sourceSessionId },
    },
  });

  if (options?.sourceSessionId) {
    try {
      await getSessionAutomationService().recordCreated({
        id: `role_wake:${session.id}`,
        sourceSessionId: options.sourceSessionId,
        type: 'role_wake',
        status: 'running',
        title: `${roleId} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}`,
        cadenceLabel: trigger === 'event' ? '任务完成后唤醒' : '定时醒来',
        sourceRefId: session.id,
        resultSessionId: session.id,
        config: {
          roleId,
          trigger,
          ...(options.handoffPrompt ? {
            handoffPrompt: options.handoffPrompt,
            nextStage: { prompt: options.handoffPrompt, title: '角色唤醒后继续' },
          } : {}),
        },
      });
    } catch (err) {
      logger.warn('Role wake automation creation feedback failed', { roleId, sessionId: session.id, error: String(err) });
    }
  }

  // ---- 步骤 5：跑实例（角色 agent 定义 + 记忆注入 + 迭代数硬约束）----
  // 双路径（web/main 路径分离）：
  //   - Electron main：TaskManager orchestrator（带 UI 事件路由 / 权限弹窗）
  //   - webServer/headless（发行版后端）：cli/bootstrap createAgentLoop（与 /api/run 同源）
  const wakePrompt = buildWakePrompt(trigger, options?.runSummary);
  const { getTaskManager } = await import('../../task');
  const tm = getTaskManager();
  const orchestrator = tm.getOrCreateCurrentOrchestrator(session.id);

  if (orchestrator) {
    if (workspacePath) {
      tm.setWorkingDirectory(session.id, workspacePath);
    }
    try {
      await orchestrator.sendMessage(wakePrompt, undefined, {
        mode: 'normal',
        agentOverrideId: roleId,
        turnSystemContext: instantiation.contextBlock ? [instantiation.contextBlock] : undefined,
        maxIterations: ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS,
      });
    } finally {
      tm.cleanup(session.id);
    }
  } else {
    await runWakeViaCliLoop({
      sessionId: session.id,
      roleId,
      wakePrompt,
      contextBlock: instantiation.contextBlock,
      workspacePath,
    });
  }

  // ---- 步骤 6：读最终产出，解析四选一决策 ----
  // 两条路径都把消息持久化进会话（orchestrator persistMessage / CLI persistAgentLoopMessageToSession），
  // 统一从会话读最后一条 assistant 消息。
  const sessionWithMessages = await sessionManager.getSession(session.id);
  const assistantMessages = (sessionWithMessages?.messages ?? []).filter((m) => m.role === 'assistant' && m.content);
  const finalOutput = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '';

  const parsedDecision = parseWakeDecision(finalOutput);
  const inferredAdvanceProposal = parsedDecision === 'advance'
    ? null
    : inferAdvanceGoalProposalFromWake(finalOutput, instantiation.contextBlock);
  const decision = inferredAdvanceProposal ? 'advance' : parsedDecision;
  let summary = finalOutput
    .replace(ROLE_PROACTIVITY.DECISION_TAG_PATTERN, '')
    .trim()
    .slice(0, ROLE_PROACTIVITY.HISTORY_SUMMARY_MAX_CHARS);
  if (inferredAdvanceProposal) {
    logger.info('Wake decision inferred as advance from verifiable next-step signals', {
      roleId,
      trigger,
      parsedDecision,
      hasVerify: !!inferredAdvanceProposal.verify,
    });
  }

  // ---- 步骤 6.5：advance 合流（P4）——多步推进升级为带完成判定的 goal run ----
  // 醒来实例是侦察兵（便宜，判断要不要推进/推进什么）；goal run 是执行者（带闸，干完过验证）。
  // 仅当 advance 且模型给出 <goal> 提案时升级；提案缺省 → 按普通 advance（侦察兵已自己做完）处理。
  let advanceGoalStatus: 'met' | 'aborted' | undefined;
  if (decision === 'advance') {
    const proposal = parseAdvanceGoalProposal(finalOutput) ?? inferredAdvanceProposal;
    if (proposal) {
      logger.info('Advance → goal run', { roleId, goal: proposal.goal, hasVerify: !!proposal.verify });
      advanceGoalStatus = await launchAdvanceGoalRun({
        sessionId: session.id,
        roleId,
        proposal,
        contextBlock: instantiation.contextBlock,
        workspacePath,
        orchestrator: tm.getOrCreateCurrentOrchestrator(session.id),
        taskManager: tm,
      });
      summary = `[goal:${advanceGoalStatus}] ${proposal.goal}`.slice(0, ROLE_PROACTIVITY.HISTORY_SUMMARY_MAX_CHARS);
    }
  }

  // ---- 步骤 7：沉默处理（归档会话，不打扰用户）----
  if (decision === 'silence') {
    await sessionManager.archiveSession(session.id);
    logger.info('Wake completed silently, session archived', { roleId, trigger, sessionId: session.id });
  } else {
    // ---- 步骤 8：非沉默推送（会话留在列表；realtime 档加桌面通知）----
    if (config.level === 'realtime') {
      await sendDesktopNotification(
        `${roleId} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}`,
        summary || `角色 ${roleId} 醒来产出了新内容`,
      );
    }
    logger.info('Wake completed with output', { roleId, trigger, decision, sessionId: session.id });
  }

  // ---- 步骤 9：写回履历（含沉默；决策入履历便于统计沉默率）+ 记忆写回 ----
  const today = now.toISOString().slice(0, 10);
  await appendRoleHistory(roleId, {
    date: today,
    artifactLabel: wakeHistoryLabel(trigger),
    artifactRef: '-',
    summary: decision === 'silence' ? '巡检无需行动' : `[${decision}] ${summary || '（无摘要）'}`,
  });

  if (decision !== 'silence') {
    // 记忆写回异步执行（quick model 判断 + write gate），失败只记日志
    runRoleWriteBack({
      roleId,
      workspacePath,
      taskPrompt: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（${trigger} 触发）`,
      finalOutput,
    }).catch((err) => logger.warn('Wake write-back failed', { roleId, error: String(err) }));
  }

  // RoleWake hook 事件（可扩展性：用户可挂自己的 command/http hook 转发）
  fireRoleWakeHook(roleId, trigger, decision, session.id, workspacePath).catch(
    (err) => logger.warn('RoleWake hook failed', { roleId, error: String(err) }),
  );

  if (options?.sourceSessionId) {
    const event: SessionAutomationEventKind = decision === 'silence'
      ? 'skipped'
      : decision === 'advance' && advanceGoalStatus === 'met'
        ? 'stage_ready'
        : 'completed';
    const status: SessionAutomationStatus = decision === 'silence'
      ? 'skipped'
      : decision === 'advance' && advanceGoalStatus === 'aborted'
        ? 'failed'
        : 'completed';
    try {
      await getSessionAutomationService().recordEvent({
        automationId: `role_wake:${session.id}`,
        event,
        status,
        recordStatus: status,
        resultSessionId: session.id,
        summary: decision === 'silence'
          ? '巡检无需行动。'
          : `[${decision}] ${summary || '角色醒来产出了新内容'}`,
        eventId: `role_wake:${session.id}:${decision}:${advanceGoalStatus ?? 'none'}`,
        lastRunAt: Date.now(),
        configPatch: {
          decision,
          advanceGoalStatus,
          ...(options.handoffPrompt ? {
            handoffPrompt: options.handoffPrompt,
            nextStage: { prompt: options.handoffPrompt, title: '角色唤醒后继续' },
          } : {}),
        },
      });
    } catch (err) {
      logger.warn('Role wake automation result feedback failed', { roleId, sessionId: session.id, error: String(err) });
    }
  }

  return { roleId, trigger, status: 'completed', decision, sessionId: session.id, summary, advanceGoalStatus };
}

// ----------------------------------------------------------------------------
// event 入口：长任务跑完触发（设计 §2.2）
// ----------------------------------------------------------------------------

/** 本次 run 中 spawn 过的持久化角色（sessionId → roleIds），run 结束后据此触发 event 醒来 */
const roleParticipationBySession = new Map<string, Set<string>>();

/** 记录角色参与（subagentExecutor 在持久化角色子代理结束时调用） */
export function recordRoleParticipation(sessionId: string, roleId: string): void {
  let roles = roleParticipationBySession.get(sessionId);
  if (!roles) {
    roles = new Set();
    roleParticipationBySession.set(sessionId, roles);
  }
  roles.add(roleId);
}

/** 取出并清空一个会话的角色参与记录 */
function takeRoleParticipation(sessionId: string): string[] {
  const roles = [...(roleParticipationBySession.get(sessionId) ?? [])];
  roleParticipationBySession.delete(sessionId);
  return roles;
}

/**
 * 长任务跑完触发参与角色醒来（runFinalizer 在 run 成功收尾后 fire-and-forget 调用）。
 * 条件（设计 §2.2）：run 达到长任务门槛 + 本次 run spawn 过持久化角色 + 非醒来会话（防递归）。
 */
export async function triggerEventWakes(sessionId: string, iterations: number, runSummary?: string): Promise<void> {
  // 长任务门槛不满足 → 清记录直接返回
  if (iterations < ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS) {
    const dropped = takeRoleParticipation(sessionId);
    if (dropped.length > 0) {
      logger.debug('Event wake skipped: below long-task threshold', { sessionId, iterations, dropped });
    }
    return;
  }

  const participants = takeRoleParticipation(sessionId);
  if (participants.length === 0) {
    logger.debug('Event wake skipped: no role participation in this run', { sessionId, iterations });
    return;
  }

  // 只有持久化角色才有资格被 event 唤醒（参与记录里可能混入 explore/coder 等内置瞬时 agent）
  const roles: string[] = [];
  for (const roleId of participants) {
    if (await isPersistentRole(roleId)) roles.push(roleId);
  }
  if (roles.length === 0) {
    logger.debug('Event wake skipped: no persistent roles participated', { sessionId, participants });
    return;
  }

  // 防递归：醒来会话自己结束不再触发 event 醒来
  try {
    const { getSessionManager } = await import('../infra/sessionManager');
    const session = await getSessionManager().getSession(sessionId, 1);
    if (session?.origin?.name === ROLE_PROACTIVITY.CADENCE_JOB_TAG) {
      logger.debug('Event wake skipped: session is itself a wake session', { sessionId });
      return;
    }
  } catch {
    // 会话读取失败不阻塞（保守继续触发，wakeRole 内部还有预算护栏）
  }

  logger.info('Long task completed, triggering event wakes', { sessionId, iterations, roles });
  for (const roleId of roles) {
    wakeRole(roleId, 'event', { sourceSessionId: sessionId, runSummary }).catch((err) =>
      logger.warn('Event wake failed', { roleId, sessionId, error: String(err) }),
    );
  }
}

// ----------------------------------------------------------------------------
// cadence cron job 同步注册（设计 §2.1，参考 memory-consolidation 幂等模式）
// ----------------------------------------------------------------------------

/**
 * 应用启动时调用：扫描所有持久化角色的主动性配置，按需注册/更新/清理 cadence cron job。
 * 幂等：以 ROLE_PROACTIVITY.CADENCE_JOB_TAG 为标识，每个角色一个 job。
 */
export async function syncCadenceJobs(): Promise<{ registered: string[]; removed: string[] }> {
  const { getCronService } = await import('../../cron/cronService');
  const cron = getCronService();

  const registered: string[] = [];
  const removed: string[] = [];

  const roles = await listPersistentRoles();
  const existingJobs = cron.listJobs({ tags: [ROLE_PROACTIVITY.CADENCE_JOB_TAG] });
  const jobByRole = new Map<string, (typeof existingJobs)[number]>();
  for (const job of existingJobs) {
    const action = job.action;
    if (action.type === 'role-wake') {
      jobByRole.set(action.roleId, job);
    }
  }

  for (const roleId of roles) {
    const config = await resolveRoleProactivityConfig(roleId);
    const cadence = cadenceForConfig(config);
    const existing = jobByRole.get(roleId);
    jobByRole.delete(roleId);

    if (!cadence) {
      // silent 档：有旧 job 则清掉
      if (existing) {
        await cron.deleteJob(existing.id);
        removed.push(roleId);
      }
      continue;
    }

    if (existing) {
      // cadence 变了则更新，没变跳过
      const existingExpression = existing.schedule.type === 'cron' ? existing.schedule.expression : null;
      if (existingExpression !== cadence) {
        await cron.updateJob(existing.id, {
          schedule: { type: 'cron', expression: cadence },
        });
        registered.push(roleId);
      }
      continue;
    }

    await cron.createJob({
      name: `[Cadence] ${roleId}`,
      description: `角色主动性：${roleId} 定时醒来巡检（内部文档）`,
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: cadence },
      action: { type: 'role-wake', roleId },
      enabled: true,
      tags: [ROLE_PROACTIVITY.CADENCE_JOB_TAG],
    });
    registered.push(roleId);
  }

  // 角色目录已删但 job 还在 → 清理
  for (const [roleId, orphanJob] of jobByRole) {
    await cron.deleteJob(orphanJob.id);
    removed.push(roleId);
  }

  if (registered.length > 0 || removed.length > 0) {
    logger.info('Cadence jobs synced', { registered, removed });
  }
  return { registered, removed };
}

// ----------------------------------------------------------------------------
// 内部 helpers
// ----------------------------------------------------------------------------

/**
 * headless 醒来路径：cli/bootstrap createAgentLoop（与 /api/run 同源的执行链路）。
 * webServer（发行版后端）没有 Electron main 的 TaskManager orchestrator，走这条。
 *
 * 简化（MVP）：角色的 system prompt 和记忆注入块通过 config.systemPrompt 附加，
 * 工具集用默认全集（角色 tools 白名单约束在这条路径暂不生效，由醒来 prompt 约束行为）。
 */
async function runWakeViaCliLoop(params: {
  sessionId: string;
  roleId: string;
  wakePrompt: string;
  contextBlock: string | null;
  workspacePath?: string;
}): Promise<void> {
  const { createCLIAgent } = await import('../../../cli/adapter');
  const { createAgentLoop } = await import('../../../cli/bootstrap');

  const agent = await createCLIAgent({
    ...(params.workspacePath ? { project: params.workspacePath } : {}),
    json: true,
  });
  const config = agent.getConfig();

  // 角色 agent 定义的 system prompt（有定义则注入，让醒来实例带角色人设）
  let rolePrompt = '';
  try {
    const { resolveAgent } = await import('../../agent/agentRegistry');
    rolePrompt = resolveAgent(params.roleId)?.prompt ?? '';
  } catch {
    // registry 不可用 → 只用记忆注入块
  }

  config.systemPrompt = [rolePrompt, params.contextBlock ?? ''].filter((s) => s.trim().length > 0).join('\n\n');
  config.maxIterations = ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS;

  const agentLoop = createAgentLoop(config, () => { /* 醒来是后台运行，无 UI 事件消费方 */ }, [], params.sessionId);
  await agentLoop.run(params.wakePrompt);
}

// ----------------------------------------------------------------------------
// advance → goal run（P4 合流，内部文档 §3.2）
// ----------------------------------------------------------------------------

/** advance goal run 的初始 prompt（goal 本体经 goalContract 注入，这里只下达任务指令） */
function buildAdvanceGoalPrompt(proposal: AdvanceGoalProposal): string {
  return [
    `你之前巡检产物时判定需要多步推进，现进入 goal 模式正式执行这个目标：`,
    proposal.goal,
    '',
    '系统会在你申请完成时独立验证，过不了会要求你继续。请一步步推进直到目标真正达成。',
  ].join('\n');
}

/**
 * 从已持久化的会话事件里读 goal 终态（Electron orchestrator 路径用——事件经
 * sessionEventService 落库，run 结束后查最后一条 goal_complete）。读不到保守按 aborted。
 */
async function readGoalTerminalFromEvents(sessionId: string): Promise<'met' | 'aborted'> {
  try {
    const { getSessionEventService } = await import('../../evaluation/sessionEventService');
    const events = getSessionEventService().getEventsByType(sessionId, 'goal_complete');
    const last = events[events.length - 1];
    const data = last?.eventData as { status?: string; degraded?: boolean } | undefined;
    // 到限放行（degraded）在无人值守场景保守当未达成：没有用户看降级徽标
    // 自行判断产物，把"验证未全过的放行"当全过会让父编排静默吞掉未完成任务。
    return data?.status === 'met' && data?.degraded !== true ? 'met' : 'aborted';
  } catch {
    return 'aborted';
  }
}

/**
 * 发起单 agent goal run（allowSwarm=false，无人值守不扇出；预算用 ADVANCE_GOAL_* 常量）。
 * 双路径（与醒来实例同构）：
 *   - Electron orchestrator：sendMessage 带 goal 选项 → 终态从落库事件读
 *   - headless CLI loop：config.goalContract + onEvent 捕获 goal_complete.status
 * 防递归：goal run 跑在醒来会话内（origin=role-cadence），其 runFinalizer 的 event 醒来被会话 origin 守卫跳过。
 */
async function launchAdvanceGoalRun(params: {
  sessionId: string;
  roleId: string;
  proposal: AdvanceGoalProposal;
  contextBlock: string | null;
  workspacePath?: string;
  orchestrator?: import('../../agent/agentOrchestrator').AgentOrchestrator;
  taskManager: import('../../task').TaskManager;
}): Promise<'met' | 'aborted'> {
  const goalPrompt = buildAdvanceGoalPrompt(params.proposal);
  // 无 verify → 把 goal 文本作为闸2 软评审条件，保证契约有完成判据（buildGoalContract 要求二选一）
  const goalInput = {
    goal: params.proposal.goal,
    verify: params.proposal.verify,
    review: params.proposal.verify ? undefined : params.proposal.goal,
    budget: SWARM_GOAL.ADVANCE_GOAL_TOKEN_BUDGET,
    maxTurns: SWARM_GOAL.ADVANCE_GOAL_MAX_TURNS,
    allowSwarm: false,
  };

  if (params.orchestrator) {
    if (params.workspacePath) params.taskManager.setWorkingDirectory(params.sessionId, params.workspacePath);
    try {
      await params.orchestrator.sendMessage(goalPrompt, undefined, {
        mode: 'normal',
        agentOverrideId: params.roleId,
        turnSystemContext: params.contextBlock ? [params.contextBlock] : undefined,
        goal: goalInput,
      });
    } finally {
      params.taskManager.cleanup(params.sessionId);
    }
    return await readGoalTerminalFromEvents(params.sessionId);
  }

  // headless：CLI loop + goalContract，onEvent 捕获终态
  const { createCLIAgent } = await import('../../../cli/adapter');
  const { createAgentLoop } = await import('../../../cli/bootstrap');
  const { buildGoalContract } = await import('../../agent/goalModeController');

  const agent = await createCLIAgent({
    ...(params.workspacePath ? { project: params.workspacePath } : {}),
    json: true,
  });
  const config = agent.getConfig();

  let rolePrompt = '';
  try {
    const { resolveAgent } = await import('../../agent/agentRegistry');
    rolePrompt = resolveAgent(params.roleId)?.prompt ?? '';
  } catch { /* registry 不可用 → 只用记忆注入块 */ }

  config.systemPrompt = [rolePrompt, params.contextBlock ?? ''].filter((s) => s.trim().length > 0).join('\n\n');
  config.goalContract = buildGoalContract({
    goal: goalInput.goal,
    verifyCommand: goalInput.verify,
    reviewCondition: goalInput.review,
    tokenBudget: goalInput.budget,
    maxTurns: goalInput.maxTurns,
    allowSwarm: false,
  });

  let terminal: 'met' | 'aborted' = 'aborted';
  const agentLoop = createAgentLoop(
    config,
    (event) => {
      if (event.type === 'goal_complete') {
        const status = (event.data as { status?: string } | undefined)?.status;
        terminal = status === 'met' ? 'met' : 'aborted';
      }
    },
    [],
    params.sessionId,
  );
  await agentLoop.run(goalPrompt);
  return terminal;
}

/** realtime 档桌面通知（headless / webServer 环境无 electron 时静默跳过） */
async function sendDesktopNotification(title: string, body: string): Promise<void> {
  try {
    const policy = evaluateNotificationPolicy('task_complete');
    if (!policy.allowed) return;
    const { Notification } = await import('electron');
    if (Notification.isSupported()) {
      new Notification({
        title: sanitizeNotificationText(title, 120),
        body: sanitizeNotificationText(body, 320),
      }).show();
    }
  } catch {
    // 非 Electron 环境（webServer headless）→ 跳过
  }
}

/** fire RoleWake hook 事件（observer-only，不影响醒来结果）。
 *  醒来发生在 run 之外，没有现成的 hookManager 实例 → 临时建一个（hook 配置从磁盘加载，醒来低频可接受）。 */
async function fireRoleWakeHook(
  roleId: string,
  trigger: RoleWakeTrigger,
  decision: RoleWakeDecision,
  sessionId: string,
  workingDirectory?: string,
): Promise<void> {
  try {
    const { createHookManager } = await import('../../hooks');
    const hookManager = createHookManager({ workingDirectory: workingDirectory?.trim() || process.cwd() });
    await hookManager.initialize();
    if (!hookManager.hasHooksFor('RoleWake')) return;
    await hookManager.triggerRoleWake({ roleId, trigger, decision, sessionId });
  } catch (err) {
    logger.debug('RoleWake hook unavailable', { error: String(err) });
  }
}
