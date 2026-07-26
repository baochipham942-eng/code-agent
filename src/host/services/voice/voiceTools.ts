// ============================================================================
// 通话侧窄工具（方案 §6.2 模式 A）
//
// 只挂三个：两个只读查询 + 一个「派活」。派活本身**不执行任何动作**，它把请求
// 转成一轮普通的 Neo 对话（带 agentOverrideId），真正的读写/命令由既有 agent
// runtime 跑，权限走既有判定链 + D4 通话抬严。通话 brain 全程零写权限（D5）。
//
// 2026-07-26 实测（见收口报告）：DashScope Realtime 的 tools 支持**按模型分化**——
// qwen3.5-omni-*-realtime 接受 tools 并真发 function_call；上一代
// qwen3-omni-flash-realtime **静默丢弃** tools 字段（session.updated 回显 tools: null，
// 不报错）。所以默认模型必须是 3.5 系，且 transport 侧对「发了 tools 却被回显成空」
// 要留痕告警——静默降级会让语音指挥台看起来只是「模型不肯调工具」。
// ============================================================================

import type { VoiceToolDefinition } from '../../../shared/contract/voice';
import { VOICE_RECENT_FILE_LIMIT, VOICE_SPAWN_TASK_MAX_ITERATIONS } from '../../../shared/constants/voice';
import { getIncompleteTasks } from '../planning/taskStore';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { buildRoleContextBlock } from '../roleAssets/roleAssetService';
import { withWorkbenchTurnSystemContext } from '../../app/workbenchTurnContext';

const logger = createLogger('VoiceTools');

export const VOICE_TOOL_DEFINITIONS: VoiceToolDefinition[] = [
  {
    type: 'function',
    name: 'get_active_tasks',
    description: '列出当前会话里还没结束的任务。用户问「现在在跑什么」「进度怎么样」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_current_file_summary',
    description: '列出本次会话最近被读写过的文件路径。用户问「你在动哪些文件」「刚才改了什么」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'spawn_task',
    description:
      '把一件需要真干活的事派给执行侧（读写文件、跑命令、多步任务都走这里）。'
      + '调用后立刻返回，任务在后台跑；不要假装任务已经做完。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话任务标题，用于展示' },
        prompt: { type: 'string', description: '给执行侧的完整指令，要包含用户的原话要点' },
      },
      required: ['title', 'prompt'],
    },
  },
];

export interface VoiceToolContext {
  neoSessionId: string;
  /** 派活时带上的专家身份；undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** 派出去的任务计数，进通话摘要 */
  onTaskSpawned: (title: string) => void;
}

/** 上游 function_call 的执行出口。返回值原样回灌给通话 brain（纯文本）。 */
export async function executeVoiceTool(
  name: string,
  rawArguments: string,
  context: VoiceToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'get_active_tasks':
        return describeActiveTasks(context.neoSessionId);
      case 'get_current_file_summary':
        return await describeRecentFiles(context.neoSessionId);
      case 'spawn_task':
        return await spawnTask(rawArguments, context);
      default:
        // 上游只可能调我们注册过的名字；调了别的说明注册面和执行面不同步，必须留痕。
        logger.warn('unknown voice tool call', { name });
        return `不支持的工具：${name}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.warn('voice tool failed', { name, message });
    return `工具执行失败：${message}`;
  }
}

function describeActiveTasks(neoSessionId: string): string {
  const tasks = getIncompleteTasks(neoSessionId);
  if (!tasks.length) return '当前没有进行中的任务。';
  return tasks.map((task) => `- ${task.subject}（${task.status}）`).join('\n');
}

/**
 * 「最近动过的文件」取自会话消息里工具调用的 file_path——host 侧没有编辑器意义上的
 * 「当前文件」（那是 Renderer 的焦点态，方案 §6.5 的 [Context — Focus] 需要一条
 * Renderer→Host 的焦点上报通道，本批没做）。这里给的是会话内真实发生过的文件动作。
 */
async function describeRecentFiles(neoSessionId: string): Promise<string> {
  const session = await getSessionManager().getSession(neoSessionId, 30);
  const paths = new Set<string>();
  for (const message of session?.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      const filePath = (call.arguments as Record<string, unknown> | undefined)?.file_path;
      if (typeof filePath === 'string' && filePath) paths.add(filePath);
    }
  }
  if (!paths.size) return '本次会话还没有读写过文件。';
  return [...paths].slice(-VOICE_RECENT_FILE_LIMIT).map((path) => `- ${path}`).join('\n');
}

/**
 * 派活：转成一轮普通对话交给既有 runtime。
 *
 * 不 await 整轮跑完——通话不能被一个几分钟的 run 冻住（方案 §6.4）。
 * agentOverrideId 让这一轮和文本侧走同一条身份链（连接器收窄、角色资料注入都在那条链上）。
 */
async function spawnTask(rawArguments: string, context: VoiceToolContext): Promise<string> {
  let parsed: { title?: string; prompt?: string };
  try {
    parsed = JSON.parse(rawArguments || '{}') as { title?: string; prompt?: string };
  } catch {
    return '任务参数解析失败，请重说一遍要做什么。';
  }
  const prompt = parsed.prompt?.trim();
  const title = parsed.title?.trim() || prompt?.slice(0, 30) || '语音派发任务';
  if (!prompt) return '缺少任务内容，没有派发。';

  const { getTaskManager } = await import('../../task');
  const orchestrator = getTaskManager().getOrCreateCurrentOrchestrator(context.neoSessionId);
  if (!orchestrator) {
    logger.warn('no orchestrator for voice spawn_task', { neoSessionId: context.neoSessionId });
    return '现在派不出任务（会话执行器不可用），可以稍后再说一次。';
  }

  // 身份链和文本轮同源。两件事都得做，各自的消费点不同：
  //   · turnSystemContext ← buildRoleContextBlock：执行 run 的全量 L0/L1（§6.7.3）。
  //     主 agent 轮**不会**自动注入角色资料，每个 host 调用方都得自己灌（cron / 组队 / 醒来都这样）。
  //   · withWorkbenchTurnSystemContext：连接器收窄的**唯一**发生地——它只在
  //     agentAppService 的两个 renderer 入口被调过，host 直调 sendMessage 一律绕开它。
  //     不显式过这一道，专家 agent.md 里声明的 connectors 在语音派的活上就是不生效（#637 同款形状）。
  const roleContextBlock = context.activeAgentId
    ? await buildRoleContextBlock(context.activeAgentId).catch(() => null)
    : null;
  const scopedOptions = withWorkbenchTurnSystemContext({
    mode: 'normal',
    ...(context.activeAgentId ? { agentOverrideId: context.activeAgentId } : {}),
    ...(roleContextBlock ? { turnSystemContext: [roleContextBlock] } : {}),
    maxIterations: VOICE_SPAWN_TASK_MAX_ITERATIONS,
  });

  context.onTaskSpawned(title);
  void orchestrator
    .sendMessage(prompt, undefined, { ...scopedOptions, mode: 'normal' })
    .catch((err: unknown) => {
      logger.warn('voice spawned task failed', {
        title,
        message: err instanceof Error ? err.message : 'unknown',
      });
    });

  return `已派出任务「${title}」，在后台跑了。`;
}
