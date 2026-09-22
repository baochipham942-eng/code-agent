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
import * as path from 'path';

import { createLogger } from '../services/infra/logger';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { isProtectedWritePath, isSensitiveCredentialPath } from '../sandbox/sensitivePaths';
import { resolveCanonicalRunPath } from '../runtime/runContext';
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

/** 明确列出的本地产物工具才允许进入扩桶；MCP、连接器和终端控制面继续 ask。
 * image_generate / video_generate 是付费远端生成，免确认即免审花钱——不进白名单（ai-review R2/R3）。 */
const PERMWIDE_TOOL_NAMES = new Set([
  'image_analyze',
  'pdf_generate',
  'ppt_generate',
  'docx_generate',
  'excel_generate',
  'chart_generate',
]);

function isJevPermissionTool(toolName: string): boolean {
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
        if (/content|body|data|prompt|text|message|token|secret|password|credential|api.?key/i.test(key)
          || /^(title|author|name|label|labels)$/i.test(key)) {
          return `${safeKey}=<omitted>`;
        }
        if (typeof value === 'string') return `${safeKey}=${value.slice(0, 256)}`;
        if (typeof value === 'number' || typeof value === 'boolean') return `${safeKey}=${String(value)}`;
        // 字符串数组（如 image_analyze 的批量 paths）必须逐项带进 state——
        // 压成 <array> 会让工作区图片与 ~/.ssh/*.png 产生完全相同的 Jev 输入，
        // 前者放行后者也被放行（ai-review R1）。敏感路径另有确定性预检拦截。
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          const items = (value as string[]).slice(0, 8).map((item) => item.slice(0, 160)).join(';');
          const suffix = (value as string[]).length > 8 ? `;…+${(value as string[]).length - 8}` : '';
          return `${safeKey}=[${items}${suffix}]`;
        }
        return `${safeKey}=<${Array.isArray(value) ? 'array' : typeof value}>`;
      })
      .join(' ') || toolName;
  const isBash = typeof args.command === 'string';
  return {
    tool: guard(toolName),
    summary: guard(summary),
    working_directory: guard(context.workingDirectory),
    // Bash 保持回放标定时的数组形状（阈值按旧形状校准，ai-review R4）；
    // 非 Bash 用命名键（探针实证：数组下标引用会判错）。不做去重按下标取值——
    // Linux 上 os.tmpdir()=/tmp 会让标签错位。
    temp_dirs: isBash
      ? [...new Set([os.tmpdir(), '/tmp', '/private/tmp'])].map(guard)
      : {
          system_tmp: guard(os.tmpdir()),
          posix_tmp: guard('/tmp'),
          private_tmp: guard('/private/tmp'),
        },
  };
}

let jevKeyMissingWarned = false;

/** 收集参数里的路径形字符串（顶层/数组/嵌套对象逐项），解析为真实路径。 */
function resolveArgPaths(args: Record<string, unknown>, workingDirectory: string): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown) => {
    // 含 '/' 或 '\'（Windows 绝对路径）、'~' / '.' 开头、平台绝对路径，以及任何
    // 不含空格的短串（'evil.pdf' 这类裸文件名也要过符号链接解析，ai-review R5）。
    if (typeof value === 'string' && value.length > 0
      && (value.includes('/') || value.includes('\\') || value.startsWith('~') || value.startsWith('.')
        || path.isAbsolute(value) || !value.includes(' '))) {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  for (const value of Object.values(args)) visit(value);
  return candidates.map((candidate) => {
    const expanded = candidate.startsWith('~') ? os.homedir() + candidate.slice(1) : candidate;
    const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(workingDirectory, expanded);
    // 跟随符号链接（与规则层 resolveCandidatePath 同一原语）——工作区内的
    // 链接指向区外时按区外判（ai-review R5）。
    return resolveCanonicalRunPath(resolved);
  });
}

function isWithinAny(candidate: string, roots: string[]): boolean {
  return roots.some((root) => {
    return candidate === root || candidate.startsWith(root + path.sep);
  });
}

// 每次调用重读：tmpdir 受环境影响，且避免模块加载期固化（ai-review R5 Nit）。
const JEV_WRITE_ROOTS = () => [os.tmpdir(), '/tmp', '/private/tmp'];

/**
 * 确定性边界预检：命中凭据目录、受保护写路径，或落在工作目录与临时目录之外，
 * 一律 ask 不问 Jev——边界判断不外包给第三方模型（ai-review R1/R3/R4/R5）。
 * 正文内容命中属于偏严误报，方向安全（ask 不是 deny），保持不变。
 */
function hitsDeterministicBoundary(args: Record<string, unknown>, workingDirectory: string): boolean {
  const resolvedPaths = resolveArgPaths(args, workingDirectory);
  const allowedRoots = [workingDirectory, ...JEV_WRITE_ROOTS()]
    .map((root) => resolveCanonicalRunPath(path.resolve(root)));
  return resolvedPaths.some((resolved) =>
    isSensitiveCredentialPath(resolved)
    || isProtectedWritePath(resolved, { projectRoot: workingDirectory })
    || !isWithinAny(resolved, allowedRoots));
}

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
  // 确定性边界预检只对扩桶的非 Bash 工具做（Bash 走原有四问协议，形状与
  // 判据不变）：凭据目录 / 受保护写路径 / 工作目录与临时目录之外，一律 ask。
  if (!isBashToolName(toolName) && hitsDeterministicBoundary(args, context.workingDirectory)) return null;
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
