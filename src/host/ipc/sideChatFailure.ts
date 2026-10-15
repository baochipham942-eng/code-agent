// Side-chat failure classifier — pure, no I/O.
// Lives beside sideChat.ipc.ts so the ask handler and the table-driven unit
// test share one source of truth; the raw provider payload stays in the host.
// 402 / 429 / rate-limit status go through classifyError. This file does not
// keep its own 402/429 digit or status check.

import type { SideChatFailureCause } from '../../shared/ipc/schemas';
import { AgentFailureCode } from '../../shared/contract/agentFailure';
import { hasInsufficientBalanceSignal } from '../../shared/utils/providerError';
import { classifyError } from '../model/errorClassifier';

/** cause 链上溯层数：熔断包装 → AI SDK APICallError → undici SystemError，留一层余量。 */
const CARRIED_CAUSE_CHAIN_DEPTH = 4;

const BILLING_RANK = { auth: 0, quota: 1, rate_limit: 2 } as const;
type BillingCause = keyof typeof BILLING_RANK;

/**
 * 沿 cause 链收底层错误节点。
 * 重试耗尽抛出的 RepeatedRetryableFingerprintError 文案只有「Retry stopped…」，
 * 原始 429/ECONNREFUSED 藏在 cause 链上——不读它们，这些失败在真机上全落 unknown
 * （UI 验收 2026-10-11 实测）。classifyError 自身只对熔断包装下钻，别的包装要自己走。
 */
function carriedNodes(error: unknown): unknown[] {
  const nodes: unknown[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < CARRIED_CAUSE_CHAIN_DEPTH && cursor && typeof cursor === 'object'; depth += 1) {
    nodes.push(cursor);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return nodes;
}

function nodeMessage(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const message = (node as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/** 链上第一个结构化 HTTP 状态码（status ?? statusCode），只给 401/403 文案规则用。 */
function firstHttpStatus(nodes: unknown[]): number | undefined {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const candidate = node as { status?: unknown; statusCode?: unknown };
    const statusValue = candidate.status ?? candidate.statusCode;
    if (typeof statusValue === 'number') return statusValue;
  }
  return undefined;
}

/**
 * 顶层 message 与 cause 链每个节点各问一次 classifyError。
 * 余额信号先于 429：classifyError 的 STATUS_MAP 先看状态码，429 + insufficient_quota
 * 会被它判成 rate_limit。同一节点已是余额信号时，不再采信那个 rate_limit。
 */
function billingFromNodes(nodes: unknown[]): BillingCause | undefined {
  let best: BillingCause | undefined;
  const consider = (signal: BillingCause) => {
    if (best === undefined || BILLING_RANK[signal] < BILLING_RANK[best]) best = signal;
  };
  for (const node of nodes) {
    const balance = hasInsufficientBalanceSignal(node);
    if (balance) consider('quota');
    const classified = classifyError(node);
    if (classified === 'auth') consider('auth');
    else if (classified === 'quota_exhaustion') consider('quota');
    else if (classified === 'rate_limit' && !balance) consider('rate_limit');
  }
  return best;
}

/**
 * 把底层错误（provider 文案 / executor 结构化失败码 / cause 链上携带的原始错误）
 * 归并成稳定 cause token。原始 payload 不出宿主——renderer 只拿到 token 去映射
 * 本地化文案与出路按钮，未知兜底 'unknown'。
 * 优先级：结构化超时码 > 鉴权 > 配额/账单 > 限流 > 超时文案 > 网络 > unknown。
 * 鉴权仍看 401/403 与中英文文案。配额文案（不含 rate limit、不含 402/429 数字）
 * 补 classifyError 覆盖不到的「额度/配额」说法；402 与 429 只走共享分类器。
 */
export function classifySideChatFailure(input: { message?: string; failureCode?: unknown; error?: unknown }): SideChatFailureCause {
  if (input.failureCode === AgentFailureCode.Timeout) return 'timeout';
  const chain = carriedNodes(input.error);
  const nodes: unknown[] = [];
  if (typeof input.message === 'string' && input.message.length > 0) nodes.push(input.message);
  nodes.push(...chain);
  const text = `${input.message ?? ''} ${chain.map(nodeMessage).filter((part) => part.length > 0).join(' ')}`.toLowerCase();
  const status = firstHttpStatus(chain);
  if (
    status === 401 || status === 403
    || /(?:^|[^0-9])(?:401|403)(?:[^0-9]|$)/.test(text)
    // 中文覆盖面：providerConnectionTest「认证失败/权限不足」、agentEngine「认证失败…
    // 凭据」、国内 provider 直出的「请检查访问凭证/凭证无效/未授权/无权限」等自由文案。
    || /unauthorized|forbidden|authentication|invalid[ _/-]?api[ _/-]?key|invalid[ _/-]?token|incorrect[ _/-]?api|api[ _/-]?key[ _/-]?(?:invalid|not[ _/-]?valid|expired|error)|鉴权|授权失败|认证失败|认证未通过|访问凭证|凭证无效|未授权|无权限|权限不足|密钥无效|令牌无效/.test(text)
  ) {
    return 'auth';
  }
  const billing = billingFromNodes(nodes);
  if (billing === 'auth') return 'auth';
  if (
    billing === 'quota'
    // 配额/账单文案。rate limit 不再在这里：429 频率走 classifyError → rate_limit。
    // 国内 provider 常见「余额不足/配额用尽/欠费/请充值」，共享分类器没有这些说法。
    || /insufficient[ _/-]?(?:balance|quota|credit|funds)|(?:quota|balance|credit|funds)[ _/-]?(?:exceeded|exhausted|depleted)|exceeded[ _/-]?(?:your[ _/-]?)?(?:current[ _/-]?)?quota|billing|payment[ _/-]?required|arrears|欠费|余额不足|余额已?用[尽完]|余额耗尽|配额|额度不足|额度已?用[尽完]|额度耗尽|请充值/.test(text)
  ) {
    return 'quota';
  }
  if (billing === 'rate_limit') return 'rate_limit';
  if (/timeout|timed?[ _-]?out|etimedout|econnaborted|deadline|超时/.test(text)) return 'timeout';
  if (
    // 连接类失败：Node errno（ECONNREFUSED/ENOTFOUND/ECONNRESET，ENOTFOUND 的
    // getaddrinfo 变体）、undici 的 fetch failed、浏览器侧 failed to fetch /
    // network request failed，及中文「网络错误/无法连接/断网」。Node 的 errno
    // 错误 message 自带码名，链上文案合并即可覆盖，无需再读结构化 code。
    /econnrefused|enotfound|econnreset|eai_again|getaddrinfo|fetch[ _-]?failed|failed[ _-]?to[ _-]?fetch|network[ _/-]?(?:error|failure|unreachable|down|request[ _/-]?failed)|网络错误|网络异常|网络连接|无法连接|连接失败|连接被拒|断网/.test(text)
  ) {
    return 'network';
  }
  return 'unknown';
}
