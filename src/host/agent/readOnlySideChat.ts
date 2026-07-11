// ============================================================================
// 只读侧聊（/btw）—— 上下文卫生原语（Kimi 借鉴 #3）
// ============================================================================
// 干活中途岔开问一个无关问题时，开一个继承当前会话上下文、但**禁用所有工具**
// （只读）的临时子 agent 回答，答案展示给用户但**不并回主线历史**（caller 不
// 持久化返回值）。聊完即弃，主线上下文不被污染。
//
// 实现要点（对照 Kimi bundle 的 startBtw = 继承父上下文 + unshift DenyAll）：
//   - read-only：SubagentConfig.availableTools = [] → 子 agent 无任何工具
//   - 继承上下文：把主会话最近若干条消息渲进 systemPromptOverride，让侧聊
//     感知当前进展（只读视角，不回写）
//   - 不污染主线：本服务只返回答案字符串，是否持久化由 caller 决定（CLI 直接
//     打印不入 thread；GUI 后续以 ephemeral 消息呈现）
//
// 复用现有 subagent 执行管道（同一条权限/校验/审计），通过依赖注入 executor
// 便于单测，不与 SubagentType 联合耦合（id 复用只读型 'explore' 标签）。
// ============================================================================

import type { Message } from '../../shared/contract';
import type {
  SubagentExecutionContext,
  SubagentExecutionRequest,
  SubagentResult,
} from './subagentExecutorTypes';

/** 渲进侧聊系统提示的主会话最近消息条数（够感知进展，又不撑爆 token）。 */
const RECENT_CONTEXT_MESSAGES = 12;

export interface SideChatExecutor {
  execute(request: SubagentExecutionRequest): Promise<SubagentResult>;
}

export interface ReadOnlySideChatDeps {
  executor: SideChatExecutor;
  /** 当前会话显式执行上下文，侧聊由此继承。 */
  baseContext: SubagentExecutionContext;
  /** 父会话消息历史，供侧聊感知当前进展（只读，不回写主线）。 */
  parentMessages: Message[];
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function buildInheritedSystemPrompt(parentMessages: Message[]): string {
  const recent = parentMessages.slice(-RECENT_CONTEXT_MESSAGES);
  const transcript = recent
    .map((m) => `${(m as { role?: string }).role ?? 'unknown'}: ${renderContent((m as { content?: unknown }).content)}`)
    .join('\n');

  return [
    '你是一个只读侧聊助手。用户在主任务进行中临时岔开问一个问题。',
    '你**没有任何工具**，不能修改、创建、执行任何东西——只能基于已知信息直接回答。',
    transcript
      ? `下面是主会话最近的上下文，供你理解背景：\n<conversation-context>\n${transcript}\n</conversation-context>`
      : '（当前没有可继承的主会话上下文。）',
    '简洁直接地回答用户接下来的问题，不要尝试执行操作，也不要把话题拉回主任务。',
  ].join('\n\n');
}

export async function runReadOnlySideChat(
  deps: ReadOnlySideChatDeps,
  question: string,
): Promise<string> {
  const config = {
    name: 'side-chat',
    systemPrompt: buildInheritedSystemPrompt(deps.parentMessages),
    availableTools: [], // ← 全工具 deny = read-only
  };

  const result = await deps.executor.execute({
    prompt: question,
    config,
    context: { ...deps.baseContext },
  });
  return result.output ?? '';
}
