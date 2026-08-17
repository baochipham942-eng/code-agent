import { quickTask, type QuickModelFailureReason } from '../../model/quickModel';
import { createLogger } from '../infra/logger';
import { executeVoiceTool } from './voiceTools';

const MAX_USER_TURNS = 4;
const MAX_CONTEXT_CHARS = 2_000;

interface VoiceSayDoGuardState {
  turnVersion: number;
  toolObservedVersion: number;
  intervenedVersion: number;
  recentUserTurns: string[];
}

type VoiceSayDoAuditResult =
  | { kind: 'skip'; reason: 'empty' | 'tool_observed' | 'stale' }
  | { kind: 'remove_context_pollution'; turnVersion: number }
  | { kind: 'normal' }
  | { kind: 'unavailable'; reason: SayDoClassificationFailure }
  | {
    kind: 'intervene';
    prompt: string;
    turnVersion: number;
    decisionSource: 'model' | 'deterministic_fallback';
    classificationFailure?: SayDoClassificationFailure;
  };

type SayDoClassificationFailure = QuickModelFailureReason | 'invalid_contract_output' | 'unknown_error';
type SayDoClassification =
  | { kind: 'say_without_do' | 'normal_reply' }
  | { kind: 'unavailable'; reason: SayDoClassificationFailure };
type SayDoClassifier = (input: string) => Promise<SayDoClassification>;
const logger = createLogger('VoiceSayDoGuard');

export interface VoiceSayDoGuard {
  rememberUserTurn(text: string): void;
  rememberToolCall(): void;
  audit(assistantText: string, responseId?: string, assistantItemId?: string): Promise<void>;
}

export function createVoiceSayDoGuard(
  voiceSessionId: string,
  isCurrent: () => boolean,
  queueAssistantItemDeletion: (itemId: string, onDeleted: () => void) => boolean = () => false,
): VoiceSayDoGuard {
  const state = createVoiceSayDoGuardState();
  return {
    rememberUserTurn: (text) => rememberVoiceSayDoUserTurn(state, text),
    rememberToolCall: () => rememberVoiceSayDoToolCall(state),
    async audit(assistantText, responseId, assistantItemId) {
      const result = await auditVoiceSayDoTurn(state, assistantText);
      if (!isCurrent()) return;
      if (result.kind === 'remove_context_pollution') {
        if (!assistantItemId || !queueAssistantItemDeletion(assistantItemId, () => {
          logger.info('voice say/do context pollution removed', {
            voiceSessionId,
            responseId,
            assistantItemId,
            turnVersion: result.turnVersion,
            summary: '本轮模型违规输出执行声称，已从上游对话上下文剔除',
            violation: 'execution_claim_with_tool_call',
            action: 'assistant_item_removed_from_upstream_context',
          });
        })) {
          logger.warn('voice say/do context removal unavailable', {
            voiceSessionId,
            responseId,
            turnVersion: result.turnVersion,
            reason: assistantItemId ? 'transport_unavailable' : 'assistant_item_id_missing',
            action: 'context_pollution_retained',
          });
        }
        return;
      }
      if (result.kind === 'unavailable') {
        logger.warn('voice say/do guard unavailable', {
          voiceSessionId,
          responseId,
          failureReason: result.reason,
          action: 'no_intervention',
        });
        return;
      }
      if (result.kind !== 'intervene') return;

      state.intervenedVersion = result.turnVersion;
      const latest = state.recentUserTurns.at(-1) ?? '语音请求';
      const rawArguments = JSON.stringify({
        title: latest.slice(0, 30),
        short_name: '语音任务',
        lane_key: `voice-saydo:${voiceSessionId}`,
        submission_key: `voice-saydo:${voiceSessionId}:${responseId ?? result.turnVersion}`,
        prompt: result.prompt,
      });
      // 成功代偿是预期内的保护动作，记审计信息即可；WARN 留给分类不可用、工具拒绝等真违约。
      logger.info('voice say/do guard intervened', {
        voiceSessionId,
        responseId,
        turnVersion: result.turnVersion,
        decisionSource: result.decisionSource,
        ...(result.classificationFailure ? { classificationFailure: result.classificationFailure } : {}),
        action: 'host_routed_delegate_task',
      });
      await executeVoiceTool('delegate_task', rawArguments, 'host_routed');
    },
  };
}

function createVoiceSayDoGuardState(): VoiceSayDoGuardState {
  return { turnVersion: 0, toolObservedVersion: 0, intervenedVersion: 0, recentUserTurns: [] };
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

async function classifySayDo(input: string): Promise<SayDoClassification> {
  const result = await quickTask(input, 16);
  const answer = result.content?.trim().toUpperCase();
  if (answer === 'SAY_GAP') return { kind: 'say_without_do' };
  if (answer === 'NORMAL') return { kind: 'normal_reply' };
  if (!result.success) {
    return { kind: 'unavailable', reason: result.failureReason ?? 'unknown_error' };
  }
  if (!answer) return { kind: 'unavailable', reason: 'empty_response' };
  return { kind: 'unavailable', reason: 'invalid_contract_output' };
}

function hasExplicitExternalExecutionRequest(userTurns: readonly string[]): boolean {
  const text = userTurns.join('\n');
  const requestMorphology = /(?:帮|替|为|给).{0,2}(?:我|我们)|(?:请|麻烦)(?:你)?/u;
  const externalAction = /(?:创建|新建|写入|修改|编辑|删除|保存|发送|提交|上传|下载|安装|运行|执行|启动|停止|打开|关闭|移动|复制|重命名|整理|生成|发布|部署|预约|下单|购买|支付|跑)(?:一下|一遍|个|份|条|这|那|测试)?/u;
  return requestMorphology.test(text) && externalAction.test(text);
}

function hasExplicitExecutionClaim(assistantText: string): boolean {
  // 用进行体、起始体、完成体的语法形态识别执行声称，避免维护“正在创建/已经处理”等话术词表。
  const progressive = /(?:我|这边|任务|工作)?\s*(?:正(?:在)?|还在)\s*(?:为你|帮你)?[\p{Script=Han}]{1,20}/u;
  const inceptive = /(?:我|这边|任务|工作)\s*(?:已(?:经)?)?\s*(?:开始|着手)\s*[\p{Script=Han}]{1,20}/u;
  const perfective = /(?:我|这边|任务|工作)\s*已(?:经)?\s*[\p{Script=Han}]{1,20}(?:了|好(?:了)?)/u;
  return progressive.test(assistantText) || inceptive.test(assistantText) || perfective.test(assistantText);
}

function shouldDeterministicallyIntervene(userTurns: readonly string[], assistantText: string): boolean {
  return hasExplicitExternalExecutionRequest(userTurns) && hasExplicitExecutionClaim(assistantText);
}

async function auditVoiceSayDoTurn(
  state: VoiceSayDoGuardState,
  assistantText: string,
  classifier: SayDoClassifier = classifySayDo,
): Promise<VoiceSayDoAuditResult> {
  const text = assistantText.trim();
  if (!text || state.turnVersion === 0) return { kind: 'skip', reason: 'empty' };
  const auditedVersion = state.turnVersion;
  if (state.intervenedVersion === auditedVersion) return { kind: 'skip', reason: 'tool_observed' };
  if (state.toolObservedVersion === auditedVersion) {
    return hasExplicitExecutionClaim(text)
      ? { kind: 'remove_context_pollution', turnVersion: auditedVersion }
      : { kind: 'skip', reason: 'tool_observed' };
  }

  const userTurns = [...state.recentUserTurns];
  const classification = await classifier(buildAuditInput(userTurns, text));
  if (state.turnVersion !== auditedVersion) return { kind: 'skip', reason: 'stale' };
  if (classification.kind === 'unavailable') {
    if (!shouldDeterministicallyIntervene(userTurns, text)) {
      return { kind: 'unavailable', reason: classification.reason };
    }
  } else if (classification.kind === 'normal_reply') {
    return { kind: 'normal' };
  }

  return {
    kind: 'intervene',
    turnVersion: auditedVersion,
    decisionSource: classification.kind === 'unavailable' ? 'deterministic_fallback' : 'model',
    ...(classification.kind === 'unavailable' ? { classificationFailure: classification.reason } : {}),
    prompt: [
      '执行用户在本通实时语音里最近提出、但尚未真正执行的工作。',
      '结合随任务附带的完整通话字幕消解指代；不要把助手口头声称的结果当成已完成证据。',
      ...userTurns.map((turn) => `[USER] ${turn}`),
    ].join('\n'),
  };
}
