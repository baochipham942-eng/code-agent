// ============================================================================
// Role First Wake — 新角色入库后的一次性「首次醒来」介绍
// ============================================================================
//
// confirmRoleDraft 落库新角色后 enqueue 一次只读的首次醒来 run：
//   - 工具面 = TOOLSCOPE 醒来白名单 ∩ permissionLevel=read（空 = 拒绝全部哨兵）
//   - 提示词变体由已连接源决定（connector / mcp_template 且 runtime=connected）
//   - 产出 = 自我介绍 + 最多 3 条可一键委托的建议（first_wake_suggestions 块）
//   - 状态机落 roles/<roleId>/first-wake.json：pending → running → completed/skipped/failed
//     （run 抛错也封口成 failed 终态，绝不把状态卡在 running/pending）
//
// 与 wakeRole 的关系：复用它的工具收窄（resolveWakeRunToolScope）与会话/自动化
// 记录范式，但刻意忽略主动性等级、免打扰时段与每日醒来预算——用户刚建完角色，
// 现在就要这份介绍；首次醒来也不计入醒来次数。失败不重试、不重发。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../infra/logger';
import { getSessionAutomationService } from '../sessionAutomation';
import { ROLE_PROACTIVITY } from '../../../shared/constants';
import { UNATTENDED_TRUST_NOTICE } from '../../../shared/unattendedTrust';
import type {
  RoleFirstWakeSnapshot,
  RoleFirstWakeSuggestion,
  RoleFirstWakeStateName,
} from '../../../shared/contract/roleAssets';
import { getRoleFirstWakePath, isSafeRoleId } from './roleAssetPaths';
import { readRolePersonalization, toRoleBoundaryRunAllowlist } from './rolePersonalization';
import { resolveWakeRunToolScope } from './roleProactivity';

const logger = createLogger('RoleFirstWake');

/** 建议块的 fenced 语言标记（提示词与解析共用同一拼写） */
const SUGGESTIONS_BLOCK_TAG = 'first_wake_suggestions';
const SUGGESTIONS_BLOCK_PATTERN = /```first_wake_suggestions\s*([\s\S]*?)```/i;
const MAX_SUGGESTIONS = 3;
const TITLE_MAX_CHARS = 80;
const PROMPT_MAX_CHARS = 500;

/** 首次醒来会话标题后缀（run list 识别用） */
const FIRST_WAKE_TITLE = 'first wake';

// ----------------------------------------------------------------------------
// 状态文件
// ----------------------------------------------------------------------------

interface RoleFirstWakeState {
  state: RoleFirstWakeStateName;
  enqueuedAt: number;
  sessionId?: string;
  sourcesMode: 'connected' | 'none';
  suggestions: RoleFirstWakeSuggestion[];
}

/** 临时文件序号：跳过与收尾并发写同一角色时避免 temp 名相撞 */
let tempFileSeq = 0;

/** 原子写：temp + rename，读方永远看不到半个 JSON。 */
async function writeFirstWakeState(roleId: string, state: RoleFirstWakeState): Promise<void> {
  const filePath = getRoleFirstWakePath(roleId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${++tempFileSeq}`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await fs.rename(tempPath, filePath);
}

async function readFirstWakeState(roleId: string): Promise<RoleFirstWakeState | null> {
  try {
    const raw = await fs.readFile(getRoleFirstWakePath(roleId), 'utf-8');
    return JSON.parse(raw) as RoleFirstWakeState;
  } catch {
    return null;
  }
}

/** 首次醒来快照（IPC firstWakeGet；无状态文件 = 从未入队 → null） */
export async function getFirstWakeSnapshot(roleId: string): Promise<RoleFirstWakeSnapshot | null> {
  if (!isSafeRoleId(roleId)) return null;
  const state = await readFirstWakeState(roleId);
  if (!state) return null;
  return {
    state: state.state,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    sourcesMode: state.sourcesMode,
    suggestions: Array.isArray(state.suggestions) ? state.suggestions : [],
  };
}

// ----------------------------------------------------------------------------
// 提示词（两个模板常量；语言规则与角色提示词同款：用户语言，默认中文）
// ----------------------------------------------------------------------------

function expectationLine(userExpectation: string): string[] {
  return userExpectation ? [`用户创建你时留下的期望：「${userExpectation}」`, ''] : [];
}

/** 有已连接源：看真实数据 → 自我介绍 + 最多 3 条可一键委托的建议。 */
const FIRST_WAKE_PROMPT_CONNECTED = (sourceNames: readonly string[], userExpectation: string): string => [
  '你刚被用户创建为一位持久化专家，这是你的第一次醒来。这不是用户发来的消息，用户现在不在场。',
  '',
  ...expectationLine(userExpectation),
  '当前已连接的数据源：',
  ...sourceNames.map((name) => `- ${name}`),
  '',
  '你的任务：',
  '1. 只用只读工具逐一查看这些已连接的源，弄清里面到底有什么（列表、文件、记录、最近活动）。不发送任何消息，不修改任何内容。',
  '2. 结合你的职责与刚才实际看到的数据，判断你能帮用户做的三件左右具体的事。',
  '3. 先给用户一段 2-3 句的自我介绍：你是谁、擅长什么、刚才在已连接的源里看到了什么。',
  `4. 回复末尾必须带一个建议块（fenced code block，语言标记 ${SUGGESTIONS_BLOCK_TAG}），内容是 JSON 数组，最多 3 项，每项形如 { "title": "...", "prompt": "..." }：`,
  '   - title：一句话标题，用户扫一眼就懂',
  '   - prompt：用户点这条建议时直接发给你的完整委托，用用户的口吻写',
  '   - 每条都必须基于你刚才实际看到的数据，不许编造任务或数据',
  '   - 实在没有值得建议的，就给空数组 []',
  '',
  '语言规则：用用户的语言回答；判断不出用户语言时默认中文。',
  '',
  `预算约束：你最多有 ${ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS} 轮工具调用，超出会被强制结束，先看最重要的源。`,
].join('\n');

/** 无已连接源：从职责出发自我介绍 + 引导连接；绝不编造任务或数据。 */
const FIRST_WAKE_PROMPT_NONE = (userExpectation: string): string => [
  '你刚被用户创建为一位持久化专家，这是你的第一次醒来。这不是用户发来的消息，用户现在不在场。',
  '',
  ...expectationLine(userExpectation),
  '当前没有任何已连接的数据源，你没有可查看的真实数据。',
  '',
  '你的任务：',
  '1. 绝对不要编造任务、数据、文件或来源——你没有数据，编造会误导用户。',
  '2. 给用户一段 2-3 句的自我介绍：你是谁、擅长什么。',
  '3. 根据你的职责说明：哪几类数据源或连接对你最有帮助、连上之后你能多做什么、在哪里连接（设置 → 插件）。',
  `4. 回复末尾必须带一个空建议块（fenced code block，语言标记 ${SUGGESTIONS_BLOCK_TAG}），内容是 []。`,
  '',
  '语言规则：用用户的语言回答；判断不出用户语言时默认中文。',
].join('\n');

// ----------------------------------------------------------------------------
// 建议解析（容错：块缺失 / JSON 坏都不重试不重发，产出空表）
// ----------------------------------------------------------------------------

function parseFirstWakeSuggestions(
  finalOutput: string,
  mode: 'connected' | 'none',
): RoleFirstWakeSuggestion[] {
  // none 模式的 host 侧硬闸：无源时模型给什么都不采纳，杜绝编造。
  if (mode === 'none') return [];
  const block = finalOutput.match(SUGGESTIONS_BLOCK_PATTERN)?.[1];
  if (!block?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const suggestions: RoleFirstWakeSuggestion[] = [];
  for (const item of parsed) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const title = typeof (item as { title?: unknown }).title === 'string'
      ? (item as { title: string }).title.trim().slice(0, TITLE_MAX_CHARS).trim()
      : '';
    const prompt = typeof (item as { prompt?: unknown }).prompt === 'string'
      ? (item as { prompt: string }).prompt.trim().slice(0, PROMPT_MAX_CHARS).trim()
      : '';
    if (!title || !prompt) continue;
    const key = `${title}\n${prompt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ title, prompt });
  }
  return suggestions;
}

// ----------------------------------------------------------------------------
// 工具面：TOOLSCOPE 白名单 ∩ 只读档
// ----------------------------------------------------------------------------

/**
 * 首次醒来的允许名单。
 * 角色声明了工具：TOOLSCOPE 醒来白名单（声明 − 对外副作用 − 硬边界收窄）为候选。
 * 角色没声明工具：默认工具表（全部已注册工具定义）为候选。
 * 两条路都再 ∩ permissionLevel=read——写/执行/网络与非只读 MCP 一律出局；
 * 空结果用拒绝全部哨兵表达，不是「不限制」。
 */
async function resolveFirstWakeAllowedToolNames(roleId: string): Promise<string[]> {
  const { getAllToolDefinitions } = await import('../../tools/dispatch/toolDefinitions');
  const definitions = getAllToolDefinitions();
  const levelByName = new Map(definitions.map((definition) => [definition.name, definition.permissionLevel]));
  const wakeScope = await resolveWakeRunToolScope(roleId);
  const candidates = wakeScope.allowedToolNames ?? definitions.map((definition) => definition.name);
  const readOnly = candidates.filter((name) => levelByName.get(name) === 'read');
  return toRoleBoundaryRunAllowlist(readOnly);
}

// ----------------------------------------------------------------------------
// 已连接源
// ----------------------------------------------------------------------------

/** 已连接源 = 能力中心里 kind connector / mcp_template 且 runtime=connected 的条目名。 */
async function listConnectedSourceNames(): Promise<string[]> {
  try {
    const { getCapabilityCenterService } = await import('../capabilities/capabilityCenterService');
    const inventory = await getCapabilityCenterService().listCapabilities();
    return inventory.items
      .filter((item) => (item.kind === 'connector' || item.kind === 'mcp_template')
        && item.state.runtime === 'connected')
      .map((item) => item.name);
  } catch (error) {
    // 能力中心不可用 → 按「无已连接源」处理（none 变体，绝不编造）
    logger.warn('First wake connected-source lookup failed, falling back to none', { error: String(error) });
    return [];
  }
}

// ----------------------------------------------------------------------------
// 执行器（可注入；默认镜像 wakeRole 的两条分支）
// ----------------------------------------------------------------------------

/** 可注入执行器（测试用 fake；生产走默认双分支执行器） */
type FirstWakeRunner = (input: {
  roleId: string;
  sessionId: string;
  prompt: string;
  allowedToolNames: string[];
}) => Promise<{ finalOutput: string }>;

/**
 * 默认执行器：Electron main 走 TaskManager orchestrator（UI 事件路由 / 权限弹窗），
 * webServer/headless 走 CLI agent loop（与 /api/run 同源），两路都从会话读最后一条
 * assistant 消息作为产出。与 wakeRole 的 runWakeViaCliLoop 同构但自带一份精简实现：
 * 那个私有函数的工具面在内部解析，没有只读交集参数，导出并改签名会超出本单对
 * roleProactivity.ts「只加 export」的约束。
 */
async function defaultFirstWakeRunner(input: {
  roleId: string;
  sessionId: string;
  prompt: string;
  allowedToolNames: string[];
}): Promise<{ finalOutput: string }> {
  const { getSessionManager } = await import('../infra/sessionManager');
  const sessionManager = getSessionManager();
  const session = await sessionManager.getSession(input.sessionId);
  const workspacePath = session?.workingDirectory;

  const { getTaskManager } = await import('../../task');
  const tm = getTaskManager();
  const orchestrator = tm.getOrCreateCurrentOrchestrator(input.sessionId);

  if (orchestrator) {
    if (workspacePath) {
      tm.setWorkingDirectory(input.sessionId, workspacePath);
    }
    try {
      await orchestrator.sendMessage(input.prompt, undefined, {
        mode: 'normal',
        inputSource: 'automation',
        systemInstructions: [UNATTENDED_TRUST_NOTICE],
        disableAutoAgent: true,
        agentOverrideId: input.roleId,
        maxIterations: ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS,
        allowedToolNames: input.allowedToolNames,
      });
    } finally {
      tm.cleanup(input.sessionId);
    }
  } else {
    const { createCLIAgent } = await import('../../../cli/adapter');
    const { createAgentLoop } = await import('../../../cli/bootstrap');

    const agent = await createCLIAgent({
      ...(workspacePath ? { project: workspacePath } : {}),
      json: true,
    });
    const config = agent.getConfig();

    // 角色 agent 定义的 system prompt（有定义则注入，让首次醒来实例带角色人设）
    let rolePrompt = '';
    try {
      const { resolveAgent } = await import('../../agent/agentRegistry');
      rolePrompt = resolveAgent(input.roleId)?.prompt ?? '';
    } catch {
      // registry 不可用 → 不注入角色 prompt
    }

    config.systemPrompt = rolePrompt;
    config.systemInstructions = [UNATTENDED_TRUST_NOTICE];
    config.maxIterations = ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS;
    // 首次醒来是无人值守发起，不进上线后评测分母。
    config.originKind = 'headless';
    config.allowedToolNames = input.allowedToolNames;

    const agentLoop = createAgentLoop(config, () => { /* 后台运行，无 UI 事件消费方 */ }, [], input.sessionId);
    await agentLoop.run(input.prompt);
  }

  // 两条路径都把消息持久化进会话，统一从会话读最后一条 assistant 消息。
  const sessionWithMessages = await sessionManager.getSession(input.sessionId);
  const assistantMessages = (sessionWithMessages?.messages ?? [])
    .filter((m) => m.role === 'assistant' && m.content);
  return {
    finalOutput: assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '',
  };
}

// ----------------------------------------------------------------------------
// 入队（幂等、竞态安全、绝不向调用方抛错）
// ----------------------------------------------------------------------------

export interface FirstWakeEnqueueResult {
  enqueued: boolean;
  /** 文件已存在（任何状态）→ 不动它 */
  reason?: 'exists';
}

export interface FirstWakeDeps {
  runner?: FirstWakeRunner;
}

/** 单槽串行队列：同一时刻至多一个首次醒来在跑，后来的排队等。链上每节自吞错，永不 reject。 */
let firstWakeQueueTail: Promise<void> = Promise.resolve();

function scheduleFirstWakeRun(roleId: string, deps?: FirstWakeDeps): void {
  // setImmediate 起 run 在后面的 tick：confirmRoleDraft 先返回，enqueue 调用方不等这次 run。
  setImmediate(() => {
    firstWakeQueueTail = firstWakeQueueTail.then(() => runFirstWake(roleId, deps));
  });
}

export async function enqueueFirstWake(roleId: string, deps?: FirstWakeDeps): Promise<FirstWakeEnqueueResult> {
  try {
    if (!isSafeRoleId(roleId)) {
      logger.warn('First wake enqueue rejected: invalid role id', { roleId });
      return { enqueued: false };
    }
    const filePath = getRoleFirstWakePath(roleId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const pending: RoleFirstWakeState = {
      state: 'pending',
      enqueuedAt: Date.now(),
      sourcesMode: 'none',
      suggestions: [],
    };
    // 独占创建（wx）：并发 enqueue 只有一个赢，其余拿 EEXIST → exists（任何状态都不重入）
    const handle = await fs.open(filePath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(pending, null, 2)}\n`, 'utf-8');
    } finally {
      await handle.close();
    }
    scheduleFirstWakeRun(roleId, deps);
    return { enqueued: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { enqueued: false, reason: 'exists' };
    }
    logger.warn('First wake enqueue failed', { roleId, error: String(error) });
    return { enqueued: false };
  }
}

// ----------------------------------------------------------------------------
// 跳过（终态封口）
// ----------------------------------------------------------------------------

export async function skipFirstWake(roleId: string): Promise<{ success: boolean }> {
  try {
    if (!isSafeRoleId(roleId)) return { success: false };
    const current = await readFirstWakeState(roleId);
    // completed / skipped / failed / 无状态文件：no-op（跳过的语义是「别再弹」，没有东西可跳也算达成）
    if (!current || (current.state !== 'pending' && current.state !== 'running')) {
      return { success: true };
    }
    await writeFirstWakeState(roleId, { ...current, state: 'skipped', suggestions: [] });
    logger.info('First wake skipped by user', { roleId, previousState: current.state });
    return { success: true };
  } catch (error) {
    logger.warn('First wake skip failed', { roleId, error: String(error) });
    return { success: false };
  }
}

// ----------------------------------------------------------------------------
// run（状态机主体）
// ----------------------------------------------------------------------------

async function recordFirstWakeResult(
  sessionId: string,
  event: 'completed' | 'skipped' | 'failed',
  summary: string,
): Promise<void> {
  try {
    await getSessionAutomationService().recordEvent({
      automationId: `role_wake:${sessionId}`,
      event,
      status: event,
      recordStatus: event,
      resultSessionId: sessionId,
      summary,
      eventId: `role_wake:${sessionId}:first_wake:${event}`,
      lastRunAt: Date.now(),
    });
  } catch (error) {
    logger.warn('First wake automation result feedback failed', { sessionId, event, error: String(error) });
  }
}

/**
 * 跑一次首次醒来。状态不是 pending（用户已跳过 / 已跑过 / 状态丢失）时什么都不做。
 * 注意：主机在 running 中重启不会重跑——状态文件留在 running，直到角色目录被删
 * （重删同 id 重建角色等于新文件、新的一次首次醒来）。
 */
async function runFirstWake(roleId: string, deps?: FirstWakeDeps): Promise<void> {
  let session: { id: string } | null = null;
  try {
    const current = await readFirstWakeState(roleId);
    if (current?.state !== 'pending') return;

    const allowedToolNames = await resolveFirstWakeAllowedToolNames(roleId);
    const sourceNames = await listConnectedSourceNames();
    const sourcesMode = sourceNames.length > 0 ? 'connected' : 'none';
    const userExpectation = readRolePersonalization(roleId).userExpectation;
    const prompt = sourcesMode === 'connected'
      ? FIRST_WAKE_PROMPT_CONNECTED(sourceNames, userExpectation)
      : FIRST_WAKE_PROMPT_NONE(userExpectation);

    // 建会话（与 wakeRole 同范式；type schedule + cron origin 标记防 event 递归触发）
    const { getSessionManager } = await import('../infra/sessionManager');
    const { getConfigService } = await import('../core/configService');
    const { resolveSessionDefaultModelConfig } = await import('../core/sessionDefaults');

    const sessionManager = getSessionManager();
    const settings = getConfigService().getSettings();
    const currentSessionId = sessionManager.getCurrentSessionId();
    const currentSession = currentSessionId ? await sessionManager.getSession(currentSessionId) : null;
    // workspace 解析链（与 wakeRole 同序）：当前会话 > CODE_AGENT_WORKING_DIR > 用户偏好。
    // 不能落到 process.cwd()——那是应用安装目录。
    const workspacePath = currentSession?.workingDirectory
      ?? process.env.CODE_AGENT_WORKING_DIR?.trim()
      ?? settings.workspace?.pinnedDirectory
      ?? settings.workspace?.recentDirectories?.[0]
      ?? settings.workspace?.defaultDirectory;

    session = await sessionManager.createSession({
      title: `${roleId} · ${FIRST_WAKE_TITLE}`,
      // 不传常量兜底——让 resolver 落到 settings.models.default（headless 无 currentSession）
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
        metadata: { roleId, trigger: 'first_wake' },
      },
    });

    // pending → running（跳过若先到，这里读到的已是 skipped → 不跑）
    const recheck = await readFirstWakeState(roleId);
    if (recheck?.state !== 'pending') {
      logger.info('First wake aborted before start: state changed', { roleId, state: recheck?.state });
      return;
    }
    await writeFirstWakeState(roleId, {
      ...recheck,
      state: 'running',
      sessionId: session.id,
      sourcesMode,
    });

    // 可见的自动化记录（run list 里能看到这次首次醒来）
    try {
      await getSessionAutomationService().recordCreated({
        id: `role_wake:${session.id}`,
        sourceSessionId: null,
        type: 'role_wake',
        status: 'running',
        title: `${roleId} · ${FIRST_WAKE_TITLE}`,
        sourceRefId: session.id,
        resultSessionId: session.id,
        config: { roleId, trigger: 'first_wake' },
      });
    } catch (error) {
      logger.warn('First wake automation creation feedback failed', { roleId, sessionId: session.id, error: String(error) });
    }

    const runner = deps?.runner ?? defaultFirstWakeRunner;
    const { finalOutput } = await runner({ roleId, sessionId: session.id, prompt, allowedToolNames });
    const suggestions = parseFirstWakeSuggestions(finalOutput, sourcesMode);

    // 跑完前用户跳过：状态保持 skipped、不写建议；自动化记录收尾避免卡 running。
    const after = await readFirstWakeState(roleId);
    if (after?.state === 'skipped') {
      await recordFirstWakeResult(session.id, 'skipped', '用户跳过了首次醒来。');
      return;
    }

    await writeFirstWakeState(roleId, {
      state: 'completed',
      enqueuedAt: current.enqueuedAt,
      sessionId: session.id,
      sourcesMode,
      suggestions,
    });
    await recordFirstWakeResult(session.id, 'completed', `首次醒来完成，给出 ${suggestions.length} 条建议。`);
    logger.info('First wake completed', { roleId, sessionId: session.id, sourcesMode, suggestions: suggestions.length });
  } catch (error) {
    logger.warn('First wake run failed (no retry)', { roleId, error: String(error) });
    // 失败也要落终态：不写的话状态文件永久停在 running（前置步骤抛错则停在 pending），
    // firstWakeGet 永远报「进行中」，enqueue 又因文件已存在永不重跑。skipped 优先——
    // 用户已跳过的失败不覆盖 skipped（与成功路径同一条规则）。
    try {
      const current = await readFirstWakeState(roleId);
      if (current && (current.state === 'pending' || current.state === 'running')) {
        await writeFirstWakeState(roleId, {
          ...current,
          state: 'failed',
          ...(session ? { sessionId: session.id } : {}),
          suggestions: [],
        });
      }
    } catch (writeError) {
      logger.warn('First wake failed-state write failed', { roleId, error: String(writeError) });
    }
    if (session) {
      await recordFirstWakeResult(session.id, 'failed', `首次醒来执行失败：${String(error)}`);
    }
  }
}
