// ============================================================================
// PermissionClassifier 的 Jev（TypeSafe System One）分类档
// ============================================================================
// 从 permissionClassifier.ts 拆出（eslint max-lines 1000 有效行硬门）：
// state 构造 + 出境脱敏 + 四问消费 + 放行判据全在这里，分类器主文件只留调用。
//
// ponytail: Jev 只缩小 ask 桶，不扩 approve 边界，不做 deny——生效范围是 Bash +
// PERMWIDE_TOOL_NAMES 明确列出的本地产物工具（扩桶工具额外要求 beyond_scope 过关）。
// 它官方明说对抗输入能带偏、不是安全边界；规则层的 deny/ask 判定不受它影响，它说
// destructive/exfiltration 也只是继续 ask。Jev 报错/超时/形状不对同样回落 ask
//（fail-closed，返回 null）。
// ============================================================================

import * as os from 'os';

import { createLogger } from '../services/infra/logger';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import {
  PERMCLASS_APPROVE_THRESHOLDS,
  PERMCLASS_QUESTIONS,
  PERMWIDE_QUESTIONS,
  type JevAnswers,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevSystemOneCall,
} from '../../shared/constants/jevQuestions';
import { isBashToolName, normalizeToolName } from './toolNames';
import type { ClassificationContext, ClassificationResult } from './permissionClassifier';

const logger = createLogger('PermissionClassifierJev');

/** 分类器上下文只取 Jev 需要的字段（放这里避免主文件导出整个接口）。 */
type JevContext = Pick<ClassificationContext, 'workingDirectory'>;

/** 明确列出的本地产物工具才允许进入扩桶；MCP、连接器和终端控制面继续 ask。 */
const PERMWIDE_TOOL_NAMES = new Set([
  'image_analyze',
  'pdf_generate',
  'ppt_generate',
  'docx_generate',
  'excel_generate',
  'chart_generate',
  'image_generate',
  'video_generate',
]);

export function isJevPermissionTool(toolName: string): boolean {
  return isBashToolName(toolName) || PERMWIDE_TOOL_NAMES.has(normalizeToolName(toolName));
}

/**
 * Jev 权限分类开关（默认关，与 CODEX_SANDBOX_ENABLED / CODE_AGENT_CLOUD_PROMPTS
 * 同一惯例：能力默认关，显式开启）。开启后仅影响「规则判不了→ask」那一桶——
 * 数据出境说明见 docs/shipnotes/2026-08-30-ship-note-cli-permission-mode-auto.md 追记节。
 */
export function isPermissionLlmClassifierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER === '1';
}

/**
 * 送 Jev 的 state：全命名键（集合不许用数组下标引用，探针实证会判错）。
 * 整份 state 每个字符串都先过
 * guardSensitiveText——命令文本/路径会发到 api.typesafe.ai（第三方、境外），
 * 密钥/家目录/邮箱必须在出境前抹掉。
 */
function buildJevState(toolName: string, args: Record<string, unknown>, context: JevContext): Record<string, unknown> {
  const guard = (value: string) => guardSensitiveText(value, { surface: 'telemetry', mode: 'model-context' });
  const summary = typeof args.command === 'string'
    ? args.command
    : Object.entries(args)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
        if (/content|body|data|prompt|text|message|token|secret|password|credential|api.?key/i.test(key)) {
          return `${safeKey}=<omitted>`;
        }
        if (typeof value === 'string') return `${safeKey}=${value.slice(0, 256)}`;
        if (typeof value === 'number' || typeof value === 'boolean') return `${safeKey}=${String(value)}`;
        return `${safeKey}=<${Array.isArray(value) ? 'array' : typeof value}>`;
      })
      .join(' ') || toolName;
  const tempDirs = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'])];
  return {
    tool: guard(toolName),
    summary: guard(summary),
    working_directory: guard(context.workingDirectory),
    temp_dirs: {
      system_tmp: guard(tempDirs[0] ?? '/tmp'),
      posix_tmp: guard(tempDirs[1] ?? '/tmp'),
      private_tmp: guard(tempDirs[2] ?? '/private/tmp'),
    },
  };
}

let jevKeyMissingWarned = false;

/** Jev 不可用只 warn 一行、不抛：key 缺失属配置错误只报一次，其余失败逐次留痕。 */
function warnJevUnavailable(error: unknown): void {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === 'TYPESAFE_KEY_MISSING') {
    if (jevKeyMissingWarned) return;
    jevKeyMissingWarned = true;
    logger.warn('CODE_AGENT_PERMISSION_LLM_CLASSIFIER 已开启但 TYPESAFE_API_KEY 缺失，Jev 分类不生效（保持 ask）');
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  logger.warn(`Jev 分类失败，回退 ask: ${detail}`);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function jevChoiceAnswer(answer: JevAnswers[string] | undefined): JevChoiceAnswer | null {
  if (!answer || typeof answer !== 'object' || !('choice' in answer)) return null;
  const { choice, confidence } = answer as JevChoiceAnswer;
  return typeof choice === 'string' && isUnitInterval(confidence) ? { choice, confidence } : null;
}

function jevNoulAnswer(answer: JevAnswers[string] | undefined): JevNoulAnswer | null {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) return null;
  const { noul } = answer as JevNoulAnswer;
  return isUnitInterval(noul) ? { noul } : null;
}

/**
 * Jev 分类：Bash 使用四问；扩桶工具再加 beyond_scope。所有问全过（tier + conf +
 * needs_human + secrets + config_access [+ beyond_scope]）才
 * approve（trace `jev_approve`、reason 带 tier 与四问数值供审批卡复盘）；
 * 非 Bash / 不过 / 报错 / 超时 / 形状不对一律返回 null，交回主流程的 fallback ask。
 */
export async function classifyByJev(
  toolName: string,
  args: Record<string, unknown>,
  context: JevContext,
  systemOne: JevSystemOneCall,
  startTime: number,
): Promise<ClassificationResult | null> {
  if (!isJevPermissionTool(toolName)) return null;
  const state = buildJevState(toolName, args, context);
  const questions = isBashToolName(toolName) ? PERMCLASS_QUESTIONS : PERMWIDE_QUESTIONS;
  let answers: JevAnswers;
  try {
    answers = await systemOne(state, questions);
  } catch (error) {
    warnJevUnavailable(error);
    return null;
  }

  const risk = jevChoiceAnswer(answers.risk);
  const needsHuman = jevNoulAnswer(answers.needs_human);
  const touchesSecrets = jevNoulAnswer(answers.touches_secrets);
  const configAccess = jevNoulAnswer(answers.config_or_credential_access);
  const beyondScope = isBashToolName(toolName) ? null : jevNoulAnswer(answers.beyond_scope);
  if (!risk || !needsHuman || !touchesSecrets || !configAccess || (!isBashToolName(toolName) && !beyondScope)) {
    logger.warn(`Jev 回答形状不符合预期，回退 ask: ${JSON.stringify(answers).slice(0, 200)}`);
    return null;
  }

  const thresholds = PERMCLASS_APPROVE_THRESHOLDS;
  const approved = (thresholds.tiers as readonly string[]).includes(risk.choice)
    && risk.confidence >= thresholds.minRiskConfidence
    && needsHuman.noul < thresholds.maxNeedsHuman
    && touchesSecrets.noul < thresholds.maxTouchesSecrets
    && configAccess.noul < thresholds.maxConfigAccess
    && (beyondScope === null || beyondScope.noul < thresholds.maxBeyondScope);
  if (!approved) return null;

  const reason = `Jev 判定 ${risk.choice}（conf=${risk.confidence.toFixed(2)}, `
    + `needs_human=${needsHuman.noul.toFixed(2)}, secrets=${touchesSecrets.noul.toFixed(2)}, `
    + `config_access=${configAccess.noul.toFixed(2)}`
    + (beyondScope ? `, beyond_scope=${beyondScope.noul.toFixed(2)}` : '') + '）';
  return {
    decision: 'approve',
    reason,
    confidence: risk.confidence,
    cached: false,
    // 非 Bash 的缓存 key 会把 file_path 折叠成 dirname、长串折叠成 <string:len>
    //（permissionClassifier.buildCacheKey 的 normalizeArgs）——Jev 放行若进缓存，
    // 同目录同长度的后续调用 5 分钟内绕过 Jev。Bash key 用完整命令，行为不变。
    bypassCache: !isBashToolName(toolName),
    traceStep: createTraceStep('permission_classifier', 'jev_approve', 'allow', reason, startTime),
  };
}
