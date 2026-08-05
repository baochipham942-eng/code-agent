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

import type { VoiceToolCallOrigin, VoiceToolDefinition } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import { dispatchVoiceIntent, type VoiceIntent } from './voiceAgentCoordinator';

const logger = createLogger('VoiceTools');

/**
 * 定向参数的说明（R2）。两个工具共用一份措辞：同一个参数在两处各写一半，迟早会长成
 * 两套语义，而这个参数指错了就是「想停 2 号却停了 1 号」。
 *
 * schema 刻意保持朴素 plain string（不用 enum / oneOf / integer）：DashScope 对 tools
 * 的支持按模型分化（见文件头），复杂 schema 是静默降级的高发区。取值的合法性在
 * voiceAgentCoordinator 里判，判不出就 fail-closed 说人话。
 */
const TARGET_PARAM_DESCRIPTION =
  '指定作用在哪一件活上：传 task_status 列出的那个编号（例如 "2"）。'
  + '**不传就是手上正在跑的那件**——用户没有明确指哪件时不要瞎填。'
  + '编号对不上的会被拒绝，不会退而作用到别的活上。';

export const VOICE_TOOL_DEFINITIONS: VoiceToolDefinition[] = [
  {
    type: 'function',
    name: 'task_status',
    description:
      '列出当前会话里还没结束的任务。用户问「现在在跑什么」「进度怎么样」时调用；'
      + '返回的任务编号可用于 steer_task / cancel_task 的 target。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_current_file_summary',
    description: '列出本次会话最近被读写过的文件路径。用户问「你在动哪些文件」「刚才改了什么」时调用。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'capture_screen_context',
    description:
      '拍一张用户此刻的屏幕，留给之后派出去的活看。'
      + '**只在用户明确指屏时调**（「你看下我屏幕上这个」「我屏幕上这个」「看看我现在开着的这个」）；'
      + '他没提屏幕就不要拍，更不要为了「看看情况」反复拍——那是在偷看。'
      + '**拍到的画面不会给你**：你看不见里面有什么，不要描述它，也不要说「我看到…」。'
      + '它会自动跟着你下一次 spawn_task / steer_task 交给执行侧，由执行侧去看。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'spawn_task',
    description:
      '把一件需要真干活的事派给执行侧（读写文件、跑命令、多步任务都走这里）。'
      + '返回值会告诉你接下来该对用户说什么，照它说；这件事的结果只以之后收到的消息为准。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话任务标题，用于展示' },
        short_name: { type: 'string', description: '2-4 个汉字的任务短名，用于播报、追问和取消，例如「周报」「机票」' },
        lane_key: { type: 'string', description: '目标或主题 lane 的稳定键；继续处理同一对象时必须沿用同一个键' },
        submission_key: { type: 'string', description: '本轮派发的稳定幂等键；同一轮重试必须原样复用' },
        prompt: { type: 'string', description: '给执行侧的完整指令，要包含用户的原话要点' },
        replace_current: {
          type: 'boolean',
          description:
            '用户要**放弃**正在跑的那件、改做这件时传 true（「别等它了，改做…」「算了，换成…」）。'
            + '只是给正在跑的那件补充要求或改方向，用 steer_task，不要传这个。',
        },
      },
      required: ['title', 'short_name', 'lane_key', 'submission_key', 'prompt'],
      additionalProperties: false,
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
        target: { type: 'string', description: TARGET_PARAM_DESCRIPTION },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_task',
    description:
      '停掉正在跑的任务。用户说「算了」「别做了」「停下」时调用。'
      + '用户没说清是哪一件时也必须直接调用并省略 target；Host 会用 AskUserQuestion 让用户按短名选择。'
      + '不要先调 task_status 后自己口头追问。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: TARGET_PARAM_DESCRIPTION },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_current_time',
    description:
      '查现在的日期和时间。用户问「现在几点」「今天几号」「星期几」时调用。'
      + '你自己不知道时间，必须调这个，不要让用户自己去看钟。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      '挂断这通电话。用户说「挂断」「结束通话」「先这样」「拜拜」时调用。'
      + '调用之后通话真的会结束——不要在没调它的时候说「已挂断」。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

/** 上游 function_call 的执行出口。返回值原样回灌给通话 brain（纯文本）。 */
export async function executeVoiceTool(
  name: string,
  rawArguments: string,
  origin: VoiceToolCallOrigin = 'function_call',
): Promise<string> {
  const intent = toIntent(name, rawArguments, origin);
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
function toIntent(name: string, rawArguments: string, origin: VoiceToolCallOrigin): VoiceIntent | string {
  switch (name) {
    case 'get_active_tasks':
    case 'task_status':
      return { kind: 'status', origin };
    case 'get_current_file_summary':
      return { kind: 'recent_files' };
    case 'capture_screen_context':
      return { kind: 'capture_screen' };
    case 'cancel_task': {
      // 参数解析失败不能退化成「停手上那件」：那正是本条要防的误伤。没给参数（'{}'）
      // 与给了但解析不出来是两回事，后者一律拒绝重来。
      const args = parseArgs(rawArguments);
      if (!args) return '没听清要停哪一件，什么都没停。请重说一遍。';
      const target = str(args.target);
      return { kind: 'cancel_task', origin, ...(target ? { target } : {}) };
    }
    case 'end_call':
      return { kind: 'end_call' };
    case 'get_current_time':
      return { kind: 'current_time' };
    case 'spawn_task': {
      const args = parseArgs(rawArguments);
      if (!args) return '任务参数解析失败，请重说一遍要做什么。';
      const prompt = str(args.prompt);
      if (!prompt) return '缺少任务内容，没有派发。';
      const shortName = str(args.short_name);
      const laneKey = str(args.lane_key);
      const submissionKey = str(args.submission_key);
      if (shortName && (Array.from(shortName).length < 2 || Array.from(shortName).length > 4)) {
        return '任务参数 short_name 必须是 2-4 个字，请重新起一个短名。';
      }
      // 只认真正的 true。上游把布尔发成字符串 "false" 的情况不是没有，
      // 而 `!!'false'` 是 true——那会让「派一件新活」变成「顶掉正在跑的活」。
      const replaceCurrent = args.replace_current === true;
      return {
        kind: 'spawn_task',
        origin,
        title: str(args.title) || prompt.slice(0, 30),
        ...(shortName ? { shortName } : {}),
        ...(laneKey ? { laneKey } : {}),
        ...(submissionKey ? { submissionKey } : {}),
        prompt,
        ...(replaceCurrent ? { replaceCurrent } : {}),
      };
    }
    case 'steer_task': {
      const args = parseArgs(rawArguments);
      if (!args) return '改方向的内容没听清，什么都没改。请重说一遍。';
      const instruction = str(args.instruction);
      if (!instruction) return '没听清要改成什么，什么都没改。';
      const target = str(args.target);
      return { kind: 'steer_task', origin, instruction, ...(target ? { target } : {}) };
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
