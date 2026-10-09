// Side-chat failure classifier — pure, no host runtime deps.
// Lives beside sideChat.ipc.ts so the ask handler and the table-driven unit
// test share one source of truth; the raw provider payload stays in the host.

import type { SideChatFailureCause } from '../../shared/ipc/schemas';
import { AgentFailureCode } from '../../shared/contract/agentFailure';

/**
 * 把底层错误（provider 文案 / executor 结构化失败码）归并成稳定 cause token。
 * 原始 payload 不出宿主——renderer 只拿到 token 去映射本地化文案与出路按钮，
 * 未知兜底 'unknown'。优先级：结构化超时码 > 鉴权 > 配额/账单 > 超时文案 > 网络。
 */
export function classifySideChatFailure(input: { message?: string; failureCode?: unknown }): SideChatFailureCause {
  if (input.failureCode === AgentFailureCode.Timeout) return 'timeout';
  const text = (input.message ?? '').toLowerCase();
  if (
    /(?:^|[^0-9])(?:401|403)(?:[^0-9]|$)/.test(text)
    // 中文覆盖面：providerConnectionTest「认证失败/权限不足」、agentEngine「认证失败…
    // 凭据」、国内 provider 直出的「请检查访问凭证/凭证无效/未授权/无权限」等自由文案。
    || /unauthorized|forbidden|authentication|invalid[ _/-]?api[ _/-]?key|invalid[ _/-]?token|incorrect[ _/-]?api|api[ _/-]?key[ _/-]?(?:invalid|not[ _/-]?valid|expired|error)|鉴权|授权失败|认证失败|认证未通过|访问凭证|凭证无效|未授权|无权限|权限不足|密钥无效|令牌无效/.test(text)
  ) {
    return 'auth';
  }
  if (
    /(?:^|[^0-9])(?:402|429)(?:[^0-9]|$)/.test(text)
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
    // network request failed，及中文「网络错误/无法连接/断网」。
    /econnrefused|enotfound|econnreset|eai_again|getaddrinfo|fetch[ _-]?failed|failed[ _-]?to[ _-]?fetch|network[ _/-]?(?:error|failure|unreachable|down|request[ _/-]?failed)|网络错误|网络异常|网络连接|无法连接|连接失败|连接被拒|断网/.test(text)
  ) {
    return 'network';
  }
  return 'unknown';
}
