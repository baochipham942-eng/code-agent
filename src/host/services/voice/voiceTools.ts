// ============================================================================
// 通话侧窄工具（方案 §6.2）—— 注册面 + 参数解析
//
// 本文件只做两件事：给上游注册工具 JSON Schema，把 function_call 的原始参数解析成
// VoiceIntent。一切执行、权限、记账都在 voiceAgentCoordinator（模式 B 的单一 chokepoint）。
// 通话 brain 全程零写权限（D5）。
//
// 2026-07-26 实测（见收口报告）：DashScope Realtime 的 tools 支持**按模型分化**——
// qwen3.5-omni-*-realtime 接受 tools 并真发 function_call；上一代
// qwen3-omni-flash-realtime **静默丢弃** tools 字段（session.updated 回显 tools: null，
// 不报错）。所以默认模型必须是 3.5 系，且 transport 侧对「发了 tools 却被回显成空」
// 要留痕告警——静默降级会让语音指挥台看起来只是「模型不肯调工具」。
// ============================================================================

import type { VoiceToolDefinition } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import { dispatchVoiceIntent, type VoiceIntent } from './voiceAgentCoordinator';

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
  {
    type: 'function',
    name: 'steer_task',
    description:
      '在正在跑的任务上改方向。用户说「等一下，改成……」「不是这样，应该……」时调用。'
      + '不会重新开始，是打断当前这轮并按新要求继续。',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '新的要求，要包含用户的原话要点' },
      },
      required: ['instruction'],
    },
  },
  {
    type: 'function',
    name: 'cancel_task',
    description: '停掉正在跑的任务。用户说「算了」「别做了」「停下」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_current_time',
    description:
      '查现在的日期和时间。用户问「现在几点」「今天几号」「星期几」时调用。'
      + '你自己不知道时间，必须调这个，不要让用户自己去看钟。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      '挂断这通电话。用户说「挂断」「结束通话」「先这样」「拜拜」时调用。'
      + '调用之后通话真的会结束——不要在没调它的时候说「已挂断」。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/** 上游 function_call 的执行出口。返回值原样回灌给通话 brain（纯文本）。 */
export async function executeVoiceTool(name: string, rawArguments: string): Promise<string> {
  const intent = toIntent(name, rawArguments);
  if (typeof intent === 'string') return intent;
  try {
    return await dispatchVoiceIntent(intent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.warn('voice intent failed', { name, message });
    return `工具执行失败：${message}`;
  }
}

/** 解析成功返回 Intent，失败返回一句给通话 brain 的人话。 */
function toIntent(name: string, rawArguments: string): VoiceIntent | string {
  switch (name) {
    case 'get_active_tasks':
      return { kind: 'status' };
    case 'get_current_file_summary':
      return { kind: 'recent_files' };
    case 'cancel_task':
      return { kind: 'cancel_task' };
    case 'end_call':
      return { kind: 'end_call' };
    case 'get_current_time':
      return { kind: 'current_time' };
    case 'spawn_task': {
      const args = parseArgs(rawArguments);
      if (!args) return '任务参数解析失败，请重说一遍要做什么。';
      const prompt = str(args.prompt);
      if (!prompt) return '缺少任务内容，没有派发。';
      return { kind: 'spawn_task', title: str(args.title) || prompt.slice(0, 30), prompt };
    }
    case 'steer_task': {
      const args = parseArgs(rawArguments);
      if (!args) return '改方向的内容没听清，什么都没改。请重说一遍。';
      const instruction = str(args.instruction);
      if (!instruction) return '没听清要改成什么，什么都没改。';
      return { kind: 'steer_task', instruction };
    }
    default:
      // 上游只可能调我们注册过的名字；调了别的说明注册面和执行面不同步，必须留痕。
      logger.warn('unknown voice tool call', { name });
      return `不支持的工具：${name}`;
  }
}

function parseArgs(rawArguments: string): Record<string, unknown> | null {
  try {
    return JSON.parse(rawArguments || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
