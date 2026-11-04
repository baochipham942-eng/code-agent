// ============================================================================
// Outbound Secret Mask — 可逆出云密钥掩码（N-PROMPT-SECRET-MASK）
// ============================================================================
// 出云方向：把消息文本里的密钥形态值换成占位符 {{SECRET_<KIND>_<8hex>}} 再发给模型
// 厂商；回包方向：把占位符换回原值。占位符 = HMAC(进程随机 key, 值) 前 8 位 hex，同一
// 值永远得到同一占位符（prompt cache 前缀不被扰动）。占位符→原值映射只存在内存，
// 不进日志不落盘。
//
// 规则复用 shared/security/secretPatternRegistry 的 high confidence 条目；值提取复用
// 条目自己的 redact(match, SENTINEL)——前缀/后缀（如 `API_KEY=`、`sk-`）留在明文，
// 只掩值本身。thinking / responsesOutput / image 部件两个方向都不动。
//
// 失败语义 fail-closed：掩码或还原抛错时以带稳定 code 的用户可读错误上抛，请求中
// 止，绝不静默明文外发。接线点两处同语义：ModelRouter._callProvider（legacy 引擎）
// 与 adapters/aiSdkAdapter.inferenceViaAiSdk（默认引擎的主 loop / provider fallback /
// 子代理公共入口）。占位符文本二次掩码是 no-op，两路叠加不会双重替换。

import { createHmac, randomBytes } from 'node:crypto';
import {
  secretPatternRegistry,
  type SecretPatternEntry,
} from '../../shared/security/secretPatterns';
import type { ToolCall } from '../../shared/contract';
import type {
  MessageContent,
  ModelMessage,
  ModelResponse,
  StreamCallback,
  StreamChunk,
} from '../model/types';
import { getConfigService } from '../services/core/configService';
import {
  recordOutboundMaskedRequest,
  type OutboundMaskReplacementRecord,
  type OutboundMaskRequestMeta,
} from './outboundSecretMaskRecorder';

/** redact 回调里标记「值在这里」的哨兵——真实文本里不会出现（NUL 包裹）。 */
const MASK_SENTINEL = '\u0000__NEO_OUTBOUND_SECRET__\u0000';

const HIGH_CONFIDENCE_ENTRIES: SecretPatternEntry[] = secretPatternRegistry.filter(
  (entry) => entry.confidence === 'high',
);

/** 完整占位符：{{SECRET_<TYPE 大写>_<8 位小写 hex>}}。 */
const PLACEHOLDER_PATTERN = /\{\{SECRET_[A-Z0-9_]+_[0-9a-f]{8}\}\}/g;
/**
 * 流式尾部驻留判据：文本结尾若是「可能成为占位符前缀」的最长后缀（`{`、`{{ABC`、
 * `{{SECRET_…}`、未知完整占位符），先扣住不发——占位符可能被 SSE 分片劈开，下一个
 * chunk 到齐才能还原。complete/error 时原样冲刷。
 */
const UNFINISHED_PLACEHOLDER_TAIL = /\{\{?[A-Z0-9a-f_]*\}?\}?$/;

/** 进程级随机 key：占位符可复现（同值同占位符）但跨进程不可预测。 */
const processMaskKey = randomBytes(32);
/** 占位符→原值映射。只在内存；进程重启即失效（重启后旧占位符本来就不再产生）。 */
const placeholderToValue = new Map<string, string>();

/**
 * 本次 applyOutboundSecretMask 的替换回执收集槽（N-PROMPT-SECRET-MASK-FU2）：非 null
 * 期间 placeholderFor 每产出一个占位符就追加一条 {kind, placeholder}。窗口全程同步
 * （maskModelMessages 无 await），并发请求不会串账。只存占位符形态，绝不存原值。
 */
let replacementReceipt: OutboundMaskReplacementRecord[] | null = null;

function placeholderFor(entry: { type: string }, rawValue: string): string {
  // 后跑的规则（如 url-query-token）可能命中已含内层占位符的文本（sk-{{…}}）：
  // 入映射前先展开内层，保证映射值恒为原文，回包只需还原一层。
  const value = restoreText(rawValue);
  const digest = createHmac('sha256', processMaskKey).update(value, 'utf8').digest('hex').slice(0, 8);
  const placeholder = `{{SECRET_${entry.type.toUpperCase()}_${digest}}}`;
  // 8 hex 的键控摘要理论上可碰撞：先到先得，碰撞时后到的值仍被掩码（占位符不复用原值）。
  if (!placeholderToValue.has(placeholder)) placeholderToValue.set(placeholder, value);
  replacementReceipt?.push({ kind: entry.type.toUpperCase(), placeholder });
  return placeholder;
}

/**
 * 从一次命中里拆出「值」与前缀/后缀：调条目的 redact(match, SENTINEL)，再剥掉哨兵
 * 两侧留下的前缀/后缀。redact 不含哨兵（如私钥整块替换）或拆不回原匹配时，整个
 * 匹配就是值（token 形态密钥本来就该整块掩掉）。
 */
function maskMatch(entry: SecretPatternEntry, match: RegExpExecArray): string {
  const full = match[0];
  let prefix = '';
  let suffix = '';
  let value = full;
  if (entry.redact) {
    const redacted = entry.redact(match, MASK_SENTINEL);
    const at = redacted.indexOf(MASK_SENTINEL);
    if (at >= 0) {
      const candidatePrefix = redacted.slice(0, at);
      const candidateSuffix = redacted.slice(at + MASK_SENTINEL.length);
      if (
        full.startsWith(candidatePrefix)
        && full.endsWith(candidateSuffix)
        && full.length > candidatePrefix.length + candidateSuffix.length
      ) {
        prefix = candidatePrefix;
        suffix = candidateSuffix;
        value = full.slice(prefix.length, full.length - suffix.length);
      }
    }
  }
  if (!value) return full;
  return prefix + placeholderFor(entry, value) + suffix;
}

// ---- 本模块私有规则（不改共享 registry 的 confidence，免得连带收紧日志/遥测脱敏）----

/** Luhn 校验：只吃纯数字串。 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 已知发卡段 + 对应长度：Visa / MasterCard / Amex / Discover / UnionPay / JCB。 */
function hasKnownCardIssuer(digits: string): boolean {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p4 = Number(digits.slice(0, 4));
  if (digits[0] === '4') return n === 13 || n === 16 || n === 19;
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16;
  if (p2 === 34 || p2 === 37) return n === 15;
  if (p4 === 6011 || p2 === 65) return n >= 16 && n <= 19;
  if (p2 === 62 || p2 === 35) return n >= 16 && n <= 19;
  return false;
}

/**
 * 登录令牌（Bearer）：区分大小写的 `Bearer `，令牌 >=20 字符且含数字，只掩令牌本身。
 * 「Bearer authentication scheme」这类散文没有数字、也不够长，不会命中。
 */
const BEARER_PATTERN = /\bBearer (?=[A-Za-z0-9._~+/=-]*\d)([A-Za-z0-9._~+/=-]{20,})/g;
/**
 * 银行卡号：13-19 位，数字间至多一个空格/短横；前后不得紧贴数字/字母（前面还不得是
 * 小数点或「字母数字+短横」，后面不得是 `.数字` 或 `-字母数字`——挡 UUID 尾段），再过 Luhn + 已知发卡段。
 */
const CARD_PATTERN = /(?<![\dA-Za-z.]|[\dA-Za-z]-)\d(?:[ -]?\d){12,18}(?![\dA-Za-z]|-[\dA-Za-z]|\.\d)/g;

/**
 * 邮箱：local@domain.tld，TLD >=2 个字母；前面不得紧贴 local 字符，后面不得紧贴域名字符
 * （句末句号放行）。`@scope/pkg`、`pkg@1.2.3`、`@decorator` 因缺 local 或 TLD 不会命中。
 */
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9_%+-][A-Za-z0-9._%+-]*@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})(?![A-Za-z0-9_-])/g;
/** URL userinfo（`https://user:pw@host`）：前缀落在 scheme:// 之后、host 之前——交给凭据规则，不当邮箱。 */
const URL_USERINFO_PREFIX = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i;
/** RFC 2606/6761 保留域名：文档示例，不是真实地址。 */
const RESERVED_EMAIL_DOMAIN = /(?:^|\.)example\.(?:com|org|net)$|\.(?:example|test|invalid|localhost)$/;
/** `name@2x.png` 类资源文件名：域名首段是 `<数字>x` 且尾段是常见图片/媒体扩展名。 */
const ASSET_FILE_DOMAIN = /^\d+x\.(?:png|jpe?g|gif|webp|svg|avif|heic|bmp|ico|mp4|mov)$/;
/** 代码属性 / 文件名尾巴（`x@pytest.fixture`、`docs@AGENTS.md`）：小清单，不是完整 TLD 库。 */
const CODE_TAIL_LABELS = new Set([
  'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go', 'yml', 'yaml', 'toml',
  'txt', 'sh', 'lock', 'log', 'cfg', 'ini', 'css', 'html',
  'fixture', 'cache', 'property', 'setter', 'getter', 'wraps', 'dataclass', 'staticmethod', 'classmethod',
  'abstractmethod', 'parametrize', 'skip', 'skipif', 'xfail', 'cached_property', 'lru_cache',
]);

function isEmailCandidate(text: string, offset: number, matched: string, domain: string): boolean {
  const local = matched.slice(0, matched.length - domain.length - 1);
  if (local.toLowerCase() === 'git') return false; // git@host SSH 远程
  const lower = domain.toLowerCase();
  if (RESERVED_EMAIL_DOMAIN.test(lower) || ASSET_FILE_DOMAIN.test(lower)) return false;
  if (CODE_TAIL_LABELS.has(lower.slice(lower.lastIndexOf('.') + 1))) return false;
  return !URL_USERINFO_PREFIX.test(text.slice(0, offset));
}

function maskPrivateRules(text: string): string {
  let output = text.replace(BEARER_PATTERN, (_matched, token: string) =>
    `Bearer ${placeholderFor({ type: 'bearer_token' }, token)}`);
  output = output.replace(CARD_PATTERN, (matched) => {
    const digits = matched.replace(/[ -]/g, '');
    if (!passesLuhn(digits) || !hasKnownCardIssuer(digits)) return matched;
    return placeholderFor({ type: 'card_number' }, matched);
  });
  output = output.replace(EMAIL_PATTERN, (matched: string, domain: string, offset: number, whole: string) => {
    // JSON 文本里 `\n`/`\t` 转义的字母会被吞进 local 部分：把它留在占位符之外，免得产出非法的 `\{` 转义。
    const lead = offset > 0 && whole[offset - 1] === '\\' && /[ntrbf]/.test(matched[0]) ? 1 : 0;
    const email = matched.slice(lead);
    if (email.startsWith('@') || !isEmailCandidate(whole, offset + lead, email, domain)) return matched;
    return matched.slice(0, lead) + placeholderFor({ type: 'email' }, email);
  });
  return output;
}

function maskText(text: string): string {
  return maskPrivateRules(maskSharedRules(text));
}

function maskSharedRules(text: string): string {
  let output = text;
  for (const entry of HIGH_CONFIDENCE_ENTRIES) {
    entry.pattern.lastIndex = 0;
    output = output.replace(entry.pattern, (...args: unknown[]) => {
      const matched = args[0] as string;
      const offset = args[args.length - 2] as number;
      const groups = args.slice(1, -2) as string[];
      const execMatch = [matched, ...groups] as unknown as RegExpExecArray;
      execMatch.index = offset;
      execMatch.input = output;
      if (entry.validate && !entry.validate(output, execMatch)) return matched;
      return maskMatch(entry, execMatch);
    });
  }
  return output;
}

function restoreText(text: string): string {
  if (!text.includes('{{SECRET_')) return text;
  return text.replace(PLACEHOLDER_PATTERN, (placeholder) => placeholderToValue.get(placeholder) ?? placeholder);
}

/** JSON 字符串文本里的还原：插入前先 JSON 转义，保证 arguments 仍是合法 JSON。 */
function restoreJsonText(text: string): string {
  if (!text.includes('{{SECRET_')) return text;
  return text.replace(PLACEHOLDER_PATTERN, (placeholder) => {
    const value = placeholderToValue.get(placeholder);
    return value === undefined ? placeholder : JSON.stringify(value).slice(1, -1);
  });
}

function maskContent(content: string | MessageContent[]): string | MessageContent[] {
  if (typeof content === 'string') return maskText(content);
  let changed = false;
  const parts = content.map((part) => {
    // 只掩 text 部件；thinking / compaction / image 部件一律不动。
    if (part.type === 'text' && typeof part.text === 'string') {
      const masked = maskText(part.text);
      if (masked !== part.text) {
        changed = true;
        return { ...part, text: masked };
      }
    }
    return part;
  });
  return changed ? parts : content;
}

/** 出云掩码：任何角色（含 system）的 content / toolCalls[].arguments / toolCallText。不改动入参。 */
function maskModelMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const masked = messages.map((message) => {
    let next = message;
    const content = maskContent(message.content);
    if (content !== message.content) {
      next = { ...next, content };
      changed = true;
    }
    if (message.toolCalls) {
      const sourceToolCalls = message.toolCalls;
      const toolCalls = sourceToolCalls.map((toolCall) => {
        const args = maskText(toolCall.arguments);
        return args === toolCall.arguments ? toolCall : { ...toolCall, arguments: args };
      });
      if (toolCalls.some((toolCall, index) => toolCall !== sourceToolCalls[index])) {
        next = { ...next, toolCalls };
        changed = true;
      }
    }
    if (typeof message.toolCallText === 'string') {
      const toolCallText = maskText(message.toolCallText);
      if (toolCallText !== message.toolCallText) {
        next = { ...next, toolCallText };
        changed = true;
      }
    }
    return next;
  });
  return changed ? masked : messages;
}

/** 对象树里的字符串叶子做原样还原（ModelResponse.toolCalls[].arguments 是对象形态）。
 * 映射里存的是掩码现场的原文切片（JSON 文本现场即含转义形态），这里原样给回；
 * JSON 文本形态的还原（argumentsDelta / 字符串形态参数）走 restoreJsonText 再转义。 */
function restoreStringLeaves(value: unknown): unknown {
  if (typeof value === 'string') return restoreText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const restored = restoreStringLeaves(item);
      if (restored !== item) changed = true;
      return restored;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const restored = restoreStringLeaves(child);
      if (restored !== child) changed = true;
      out[key] = restored;
    }
    return changed ? out : value;
  }
  return value;
}

/** 回包还原：content / contentParts 文本件 / toolCalls 参数。thinking 与 responsesOutput 不动。 */
function restoreModelResponse(response: ModelResponse): ModelResponse {
  let next = response;
  if (typeof response.content === 'string') {
    const restored = restoreText(response.content);
    if (restored !== response.content) next = { ...next, content: restored };
  }
  if (response.contentParts) {
    let changed = false;
    const contentParts = response.contentParts.map((part) => {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.includes('{{SECRET_')) {
        const restored = restoreText(part.text);
        if (restored !== part.text) {
          changed = true;
          return { ...part, text: restored };
        }
      }
      return part;
    });
    if (changed) next = { ...next, contentParts };
  }
  if (response.toolCalls) {
    let changed = false;
    const toolCalls = response.toolCalls.map((toolCall: ToolCall) => {
      // 契约形态是对象；个别 provider 运行时给 JSON 字符串时按 JSON 文本还原（防御）。
      const args = typeof toolCall.arguments === 'string'
        ? restoreJsonText(toolCall.arguments)
        : restoreStringLeaves(toolCall.arguments);
      if (args === toolCall.arguments) return toolCall;
      changed = true;
      return { ...toolCall, arguments: args as ToolCall['arguments'] };
    });
    if (changed) next = { ...next, toolCalls };
  }
  return next;
}

interface SplitTail {
  emit: string;
  hold: string;
}

/** 把「已还原完占位符」的文本切成可发部分 + 需驻留的疑似未完占位符尾巴。 */
function splitUnfinishedTail(text: string): SplitTail {
  const match = UNFINISHED_PLACEHOLDER_TAIL.exec(text);
  if (!match) return { emit: text, hold: '' };
  return { emit: text.slice(0, match.index), hold: match[0] };
}

/**
 * 流回调包装：text 与 tool_call_delta.argumentsDelta 里的占位符还原后下发；疑似被
 * 分片劈开的占位符尾巴扣到下一个 chunk 或 complete/error 再冲刷。reasoning 不还原。
 */
function createStreamRestorer(onStream: StreamCallback): StreamCallback {
  let pendingText = '';
  let pendingArguments = '';
  let pendingArgumentsIndex: number | undefined;

  const emit = (chunk: string | StreamChunk): void | Promise<void> => onStream(chunk);

  const flushText = async (): Promise<void> => {
    if (pendingText === '') return;
    const tail = pendingText;
    pendingText = '';
    // 走 text 通道形状（与正常下发一致），别发裸字符串让只认 typed chunk 的消费方丢字。
    await emit({ type: 'text', content: tail });
  };

  const flushArguments = async (): Promise<void> => {
    if (pendingArguments === '') return;
    const tail = pendingArguments;
    const index = pendingArgumentsIndex ?? 0;
    pendingArguments = '';
    await emit({ type: 'tool_call_delta', toolCall: { index, argumentsDelta: tail } });
  };

  return async (chunk: string | StreamChunk): Promise<void> => {
    if (typeof chunk === 'string') {
      const { emit: toEmit, hold } = splitUnfinishedTail(restoreText(pendingText + chunk));
      pendingText = hold;
      if (toEmit !== '') await emit(toEmit);
      return;
    }
    switch (chunk.type) {
      case 'text': {
        const { emit: toEmit, hold } = splitUnfinishedTail(restoreText(pendingText + (chunk.content ?? '')));
        pendingText = hold;
        if (toEmit !== '') await emit({ ...chunk, content: toEmit });
        return;
      }
      case 'tool_call_start': {
        // 工具参数不可能续完文本占位符，先冲文本尾巴。
        await flushText();
        await emit(chunk);
        return;
      }
      case 'tool_call_delta': {
        await flushText();
        const toolCall = chunk.toolCall ?? { index: 0 };
        if (pendingArgumentsIndex !== undefined && toolCall.index !== pendingArgumentsIndex) {
          await flushArguments();
        }
        pendingArgumentsIndex = toolCall.index;
        const { emit: toEmit, hold } = splitUnfinishedTail(
          restoreJsonText(pendingArguments + (toolCall.argumentsDelta ?? '')),
        );
        pendingArguments = hold;
        if (toEmit !== '') {
          await emit({ ...chunk, toolCall: { ...toolCall, argumentsDelta: toEmit } });
        }
        return;
      }
      case 'complete':
      case 'error':
      case 'stream_break': {
        await flushText();
        await flushArguments();
        await emit(chunk);
        return;
      }
      default:
        // reasoning / usage / token_estimate / reconnecting：不携带可还原文本，直通。
        await emit(chunk);
        return;
    }
  };
}

/** 掩码会话：出云消息 + 包装后的流回调 + 回包还原。 */
interface OutboundSecretMaskSession {
  readonly messages: ModelMessage[];
  readonly onStream?: StreamCallback;
  restore(response: ModelResponse): ModelResponse;
}

const MASK_FAILED_MESSAGE = 'Outbound secret masking failed; the request was not sent. You can turn off "Mask secrets before sending to the model vendor" in Settings > Privacy to send without masking. (code: OUTBOUND_SECRET_MASK_FAILED)';
const RESTORE_FAILED_MESSAGE = 'Outbound secret masking could not restore the model reply, so the reply was dropped. You can turn masking off in Settings > Privacy. (code: OUTBOUND_SECRET_MASK_RESTORE_FAILED)';

/**
 * 开关关（或缺省/settings 不可读）→ undefined，调用方走原样路径（请求字节不变）。
 * 开关开 → 立即掩码出云消息（失败抛带 code 的错误，请求中止，绝不明文外发）。
 * meta（可选 provider/model）只进替换回执（N-PROMPT-SECRET-MASK-FU2），不影响掩码本身。
 */
export function applyOutboundSecretMask(
  messages: ModelMessage[],
  onStream?: StreamCallback,
  meta?: OutboundMaskRequestMeta,
): OutboundSecretMaskSession | undefined {
  let enabled: boolean;
  try {
    enabled = getConfigService().getSettings().privacy?.outboundSecretMask === true;
  } catch {
    // settings 不可读按「关」处理——与 getProviderSettings 等既有读取点的容错口径一致。
    return undefined;
  }
  if (!enabled) return undefined;

  let masked: ModelMessage[];
  const replacements: OutboundMaskReplacementRecord[] = [];
  replacementReceipt = replacements;
  try {
    masked = maskModelMessages(messages);
  } catch (error) {
    throw new Error(MASK_FAILED_MESSAGE, { cause: error });
  } finally {
    replacementReceipt = null;
  }
  // 回执只记真发生替换的请求（空清单在 recorder 里是 no-op），且只含占位符形态。
  recordOutboundMaskedRequest(replacements, meta);

  return {
    messages: masked,
    onStream: onStream ? createStreamRestorer(onStream) : undefined,
    restore(response: ModelResponse): ModelResponse {
      try {
        return restoreModelResponse(response);
      } catch (error) {
        throw new Error(RESTORE_FAILED_MESSAGE, { cause: error });
      }
    },
  };
}
