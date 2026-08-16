import { quickTask } from '../../model/quickModel';
import { createLogger } from '../infra/logger';
import { executeVoiceTool } from './voiceTools';

const MAX_USER_TURNS = 4;
const MAX_CONTEXT_CHARS = 2_000;

interface VoiceSayDoGuardState {
  turnVersion: number;
  toolObservedVersion: number;
  recentUserTurns: string[];
}

type VoiceSayDoAuditResult =
  | { kind: 'skip'; reason: 'empty' | 'tool_observed' | 'stale' }
  | { kind: 'normal' }
  | { kind: 'unavailable' }
  | { kind: 'intervene'; prompt: string; turnVersion: number };

type SayDoClassifier = (input: string) => Promise<'say_without_do' | 'normal_reply' | null>;
const logger = createLogger('VoiceSayDoGuard');

export interface VoiceSayDoGuard {
  rememberUserTurn(text: string): void;
  rememberToolCall(): void;
  audit(assistantText: string, responseId?: string): Promise<void>;
}

export function createVoiceSayDoGuard(
  voiceSessionId: string,
  isCurrent: () => boolean,
): VoiceSayDoGuard {
  const state = createVoiceSayDoGuardState();
  return {
    rememberUserTurn: (text) => rememberVoiceSayDoUserTurn(state, text),
    rememberToolCall: () => rememberVoiceSayDoToolCall(state),
    async audit(assistantText, responseId) {
      const result = await auditVoiceSayDoTurn(state, assistantText);
      if (!isCurrent()) return;
      if (result.kind === 'unavailable') {
        logger.warn('voice say/do guard unavailable', { voiceSessionId, responseId, action: 'no_intervention' });
        return;
      }
      if (result.kind !== 'intervene') return;

      rememberVoiceSayDoToolCall(state);
      const latest = state.recentUserTurns.at(-1) ?? '语音请求';
      const rawArguments = JSON.stringify({
        title: latest.slice(0, 30),
        short_name: '语音任务',
        lane_key: `voice-saydo:${voiceSessionId}`,
        submission_key: `voice-saydo:${voiceSessionId}:${responseId ?? result.turnVersion}`,
        prompt: result.prompt,
      });
      logger.warn('voice say/do guard intervened', {
        voiceSessionId,
        responseId,
        turnVersion: result.turnVersion,
        action: 'host_routed_delegate_task',
      });
      await executeVoiceTool('delegate_task', rawArguments, 'host_routed');
    },
  };
}

function createVoiceSayDoGuardState(): VoiceSayDoGuardState {
  return { turnVersion: 0, toolObservedVersion: 0, recentUserTurns: [] };
}

function rememberVoiceSayDoUserTurn(state: VoiceSayDoGuardState, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  state.turnVersion += 1;
  state.recentUserTurns.push(trimmed);
  while (state.recentUserTurns.length > MAX_USER_TURNS) state.recentUserTurns.shift();
  while (state.recentUserTurns.join('\n').length > MAX_CONTEXT_CHARS && state.recentUserTurns.length > 1) {
    state.recentUserTurns.shift();
  }
}

function rememberVoiceSayDoToolCall(state: VoiceSayDoGuardState): void {
  state.toolObservedVersion = state.turnVersion;
}

function buildAuditInput(userTurns: readonly string[], assistantText: string): string {
  return [
    '判断这轮实时通话是否发生了“说了没做”。',
    'SAY_GAP：用户要求执行会改变文件、系统、任务或外部世界的工作，助手本轮声称已经开始、正在执行或已经完成，但本轮实际上没有任何工具调用。',
    'NORMAL：闲聊、知识回答、口头完成的事、追问缺失信息、拒绝、说明尚未执行，或没有声称工作已开始/完成。',
    '只按语义判断，不依赖固定句式。',
    '只输出 SAY_GAP 或 NORMAL，不要解释。',
    '',
    `最近用户话语：\n${userTurns.map((turn, index) => `${index + 1}. ${turn}`).join('\n')}`,
    `助手本轮回复：\n${assistantText.trim()}`,
  ].join('\n');
}

async function classifySayDo(input: string): Promise<'say_without_do' | 'normal_reply' | null> {
  const result = await quickTask(input, 16);
  const answer = result.content?.trim().toUpperCase();
  if (answer === 'SAY_GAP') return 'say_without_do';
  if (answer === 'NORMAL') return 'normal_reply';
  return null;
}

async function auditVoiceSayDoTurn(
  state: VoiceSayDoGuardState,
  assistantText: string,
  classifier: SayDoClassifier = classifySayDo,
): Promise<VoiceSayDoAuditResult> {
  const text = assistantText.trim();
  if (!text || state.turnVersion === 0) return { kind: 'skip', reason: 'empty' };
  const auditedVersion = state.turnVersion;
  if (state.toolObservedVersion === auditedVersion) return { kind: 'skip', reason: 'tool_observed' };

  const userTurns = [...state.recentUserTurns];
  const classification = await classifier(buildAuditInput(userTurns, text));
  if (state.turnVersion !== auditedVersion) return { kind: 'skip', reason: 'stale' };
  if (classification === null) return { kind: 'unavailable' };
  if (classification === 'normal_reply') return { kind: 'normal' };

  return {
    kind: 'intervene',
    turnVersion: auditedVersion,
    prompt: [
      '执行用户在本通实时语音里最近提出、但尚未真正执行的工作。',
      '结合随任务附带的完整通话字幕消解指代；不要把助手口头声称的结果当成已完成证据。',
      ...userTurns.map((turn) => `[USER] ${turn}`),
    ].join('\n'),
  };
}
