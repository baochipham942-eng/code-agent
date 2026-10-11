// Side-chat failure classifier — pure, no host runtime deps.
// Lives beside sideChat.ipc.ts so the ask handler and the table-driven unit
// test share one source of truth; the raw provider payload stays in the host.

import type { SideChatFailureCause } from '../../shared/ipc/schemas';
import { AgentFailureCode } from '../../shared/contract/agentFailure';

/** cause 链上溯层数：熔断包装 → AI SDK APICallError → undici SystemError，留一层余量。 */
const CARRIED_CAUSE_CHAIN_DEPTH = 4;

interface CarriedErrorInfo {
  /** cause 链上收集到的全部 message（含入口 error 自身），空格拼接。 */
  text: string;
  /** 链上第一个结构化 HTTP 状态码（status ?? statusCode）。 */
  status?: number;
}

/**
 * 沿 cause 链收底层错误的结构化信号（文案 / HTTP status）。
 * 重试耗尽抛出的 RepeatedRetryableFingerprintError 文案只有「Retry stopped…」，
 * 原始 429/ECONNREFUSED 藏在 cause 链与包装上保留的 status 里——不读它们，
 * 这些失败在真机上全落 unknown（UI 验收 2026-10-11 实测）。
 */
function collectCarriedErrorInfo(error: unknown): CarriedErrorInfo {
  const messages: string[] = [];
  let status: number | undefined;
  let cursor: unknown = error;
  for (let depth = 0; depth < CARRIED_CAUSE_CHAIN_DEPTH && cursor && typeof cursor === 'object'; depth += 1) {
    const candidate = cursor as { message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) messages.push(candidate.message);
    const statusValue = candidate.status ?? candidate.statusCode;
    if (status === undefined && typeof statusValue === 'number') status = statusValue;
    cursor = candidate.cause;
  }
  return { text: messages.join(' '), status };
}

/**
 * 把底层错误（provider 文案 / executor 结构化失败码 / cause 链上携带的原始错误）
 * 归并成稳定 cause token。原始 payload 不出宿主——renderer 只拿到 token 去映射
 * 本地化文案与出路按钮，未知兜底 'unknown'。
 * 优先级：结构化超时码 > 鉴权 > 配额/账单 > 超时 > 网络；鉴权/配额先看携带的
 * 结构化 status，再看文案（链上收集的文案与顶层 message 合并判定）。
 */
export function classifySideChatFailure(input: { message?: string; failureCode?: unknown; error?: unknown }): SideChatFailureCause {
  if (input.failureCode === AgentFailureCode.Timeout) return 'timeout';
  const carried = collectCarriedErrorInfo(input.error);
  const text = `${input.message ?? ''} ${carried.text}`.toLowerCase();
  if (
    carried.status === 401 || carried.status === 403
    || /(?:^|[^0-9])(?:401|403)(?:[^0-9]|$)/.test(text)
    // 中文覆盖面：providerConnectionTest「认证失败/权限不足」、agentEngine「认证失败…
    // 凭据」、国内 provider 直出的「请检查访问凭证/凭证无效/未授权/无权限」等自由文案。
    || /unauthorized|forbidden|authentication|invalid[ _/-]?api[ _/-]?key|invalid[ _/-]?token|incorrect[ _/-]?api|api[ _/-]?key[ _/-]?(?:invalid|not[ _/-]?valid|expired|error)|鉴权|授权失败|认证失败|认证未通过|访问凭证|凭证无效|未授权|无权限|权限不足|密钥无效|令牌无效/.test(text)
  ) {
    return 'auth';
  }
  if (
    carried.status === 402 || carried.status === 429
    || /(?:^|[^0-9])(?:402|429)(?:[^0-9]|$)/.test(text)
    // 配额/账单：英文 insufficient balance / quota exceeded / payment required /
    // rate limit（429 含频率与配额两义，都归 quota——重试救不了当次请求）；
    // 国内 provider 常见「余额不足/配额用尽/欠费/请充值」。
    || /insufficient[ _/-]?(?:balance|quota|credit|funds)|(?:quota|balance|credit|funds)[ _/-]?(?:exceeded|exhausted|depleted)|exceeded[ _/-]?(?:your[ _/-]?)?(?:current[ _/-]?)?quota|rate[ _/-]?limit|billing|payment[ _/-]?required|arrears|欠费|余额不足|余额已?用[尽完]|余额耗尽|配额|额度不足|额度已?用[尽完]|额度耗尽|请充值/.test(text)
  ) {
    return 'quota';
  }
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
