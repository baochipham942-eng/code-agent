// ============================================================================
// Role Proactivity — 角色主动性（cadence 触发器 + 醒来循环）
// ============================================================================
//
// 设计：docs/designs/role-proactivity.md
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
import { ROLE_PROACTIVITY, DEFAULT_PROVIDER, DEFAULT_MODELS } from '../../../shared/constants';
import type {
  RoleProactivityConfig,
  RoleProactivityLevel,
  RoleWakeDecision,
  RoleWakeResult,
  RoleWakeTrigger,
} from '../../../shared/contract/roleAssets';
import { instantiateRole, appendRoleHistory, loadRoleHistory, listPersistentRoles } from './roleAssetService';
import { runRoleWriteBack } from './roleWriteBack';

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
    '   - 【推进 advance】产物有明确的下一步且你能独立完成 → 直接做，做完汇报',
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

// ----------------------------------------------------------------------------
// 醒来循环（设计 §3）
// ----------------------------------------------------------------------------

export interface WakeRoleOptions {
  /** event 触发时的来源会话（长任务所在会话） */
  sourceSessionId?: string;
  /** event 触发时传入的 run 产出摘要（角色总结 + next steps 的输入） */
  runSummary?: string;
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
  // ---- 步骤 0：等级检查（silent 档不醒）----
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

  // ---- 步骤 2：实例化（带记忆；非持久化角色在这里抛错）----
  const { getSessionManager } = await import('../infra/sessionManager');
  const { getConfigService } = await import('../core/configService');
  const { resolveSessionDefaultModelConfig } = await import('../core/sessionDefaults');

  const sessionManager = getSessionManager();
  const configService = getConfigService();
  const settings = configService.getSettings();
  const currentSessionId = sessionManager.getCurrentSessionId();
  const currentSession = currentSessionId ? await sessionManager.getSession(currentSessionId) : null;
  const workspacePath = options?.workspacePath ?? currentSession?.workingDirectory;

  const instantiation = await instantiateRole(roleId, trigger, {
    task: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（${trigger}）`,
    workspacePath,
  });

  // ---- 步骤 3：创建醒来会话（origin 标记 role-cadence，防 event 递归触发）----
  const now = new Date();
  const titleStamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const session = await sessionManager.createSession({
    title: `${roleId} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX} ${titleStamp}`,
    modelConfig: resolveSessionDefaultModelConfig({
      provider: settings.model?.provider || currentSession?.modelConfig.provider || DEFAULT_PROVIDER,
      model: settings.model?.model || currentSession?.modelConfig.model || DEFAULT_MODELS.chat,
      temperature: settings.model?.temperature ?? currentSession?.modelConfig.temperature ?? 0.7,
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

  // ---- 步骤 4：跑实例（角色 agent 定义 + 记忆注入 + 迭代数硬约束）----
  const { getTaskManager } = await import('../../task');
  const tm = getTaskManager();
  const orchestrator = tm.getOrCreateCurrentOrchestrator(session.id);
  if (!orchestrator) {
    throw new Error(`AgentOrchestrator not available for wake session ${session.id}`);
  }
  if (workspacePath) {
    tm.setWorkingDirectory(session.id, workspacePath);
  }

  let finalOutput = '';
  try {
    const wakePrompt = buildWakePrompt(trigger, options?.runSummary);
    await orchestrator.sendMessage(wakePrompt, undefined, {
      mode: 'normal',
      agentOverrideId: roleId,
      turnSystemContext: instantiation.contextBlock ? [instantiation.contextBlock] : undefined,
      maxIterations: ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS,
    });

    // ---- 步骤 5：读最终产出，解析四选一决策 ----
    const sessionWithMessages = await sessionManager.getSession(session.id);
    const assistantMessages = (sessionWithMessages?.messages ?? []).filter((m) => m.role === 'assistant' && m.content);
    finalOutput = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '';
  } finally {
    tm.cleanup(session.id);
  }

  const decision = parseWakeDecision(finalOutput);
  const summary = finalOutput
    .replace(ROLE_PROACTIVITY.DECISION_TAG_PATTERN, '')
    .trim()
    .slice(0, ROLE_PROACTIVITY.HISTORY_SUMMARY_MAX_CHARS);

  // ---- 步骤 6：沉默处理（归档会话，不打扰用户）----
  if (decision === 'silence') {
    await sessionManager.archiveSession(session.id);
    logger.info('Wake completed silently, session archived', { roleId, trigger, sessionId: session.id });
  } else {
    // ---- 步骤 7：非沉默推送（会话留在列表；realtime 档加桌面通知）----
    if (config.level === 'realtime') {
      await sendDesktopNotification(
        `${roleId} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}`,
        summary || `角色 ${roleId} 醒来产出了新内容`,
      );
    }
    logger.info('Wake completed with output', { roleId, trigger, decision, sessionId: session.id });
  }

  // ---- 步骤 8：写回履历（含沉默；决策入履历便于统计沉默率）+ 记忆写回 ----
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

  return { roleId, trigger, status: 'completed', decision, sessionId: session.id, summary };
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
      description: `角色主动性：${roleId} 定时醒来巡检（docs/designs/role-proactivity.md）`,
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

/** realtime 档桌面通知（headless / webServer 环境无 electron 时静默跳过） */
async function sendDesktopNotification(title: string, body: string): Promise<void> {
  try {
    const { Notification } = await import('electron');
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
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
