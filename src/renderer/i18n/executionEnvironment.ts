// ADR-081 协议版本闸的旧客户端文案：宿主只回稳定码 ENVIRONMENT_PROTOCOL_UNSUPPORTED，
// 句子在这里按语言给（zh.ts / chatTranscript.ts 已贴 max-lines，独立成模块，
// 同 toolErrorCodes.ts 先例）。zh 是 ADR 推荐原文（暂行、待爸复核），en 为对应译文。

import { ENVIRONMENT_PROTOCOL_UNSUPPORTED } from '@shared/contract/executionEnvironment';
import type { Language } from './index';

const protocolUnsupportedZh = '这个客户端还不会选择执行环境。请更新之后，再把这一轮放到云端或另一台电脑上。这一轮没有开始。';
const protocolUnsupportedEn = 'This client cannot choose an execution environment yet. Update it first, then put this turn on the cloud or another computer. This turn has not started.';

const protocolUnsupportedCopy: Record<Language, string> = {
  zh: protocolUnsupportedZh,
  en: protocolUnsupportedEn,
};

function getEnvironmentProtocolUnsupportedCopy(language: Language): string {
  return protocolUnsupportedCopy[language] ?? protocolUnsupportedZh;
}

/**
 * 发送失败错误是不是协议版本闸拒绝（httpTransport 把宿主的稳定码挂在 error.code 上）。
 * 是 → 返回当前语言的那句话；不是 → undefined，调用方走原有报错路径。
 */
export function environmentProtocolUnsupportedMessage(error: unknown, language: Language): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { code?: unknown }).code === ENVIRONMENT_PROTOCOL_UNSUPPORTED
    ? getEnvironmentProtocolUnsupportedCopy(language)
    : undefined;
}
