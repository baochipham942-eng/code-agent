export type InboundAccessLocale = 'zh-CN' | 'en-US';

const messages = {
  'zh-CN': {
    pairing: (code: string, ttlMinutes: number) =>
      `配对码：${code}\n请在桌面端“自动化 > 待过目”中核对并批准。配对码 ${ttlMinutes} 分钟内有效，且只能使用一次。`,
    unauthorized: '未授权。请先在私聊中完成配对。',
    paired: '配对成功。请重新发送刚才的消息。',
  },
  'en-US': {
    pairing: (code: string, ttlMinutes: number) =>
      `Pairing code: ${code}\nVerify and approve it in Desktop > Automations > Review inbox. The code expires in ${ttlMinutes} minutes and can be used once.`,
    unauthorized: 'Unauthorized. Complete pairing in a direct message first.',
    paired: 'Pairing approved. Please send your message again.',
  },
} as const;

export function inboundAccessText(
  locale: InboundAccessLocale | undefined,
  key: 'unauthorized' | 'paired',
): string;
export function inboundAccessText(
  locale: InboundAccessLocale | undefined,
  key: 'pairing',
  code: string,
  ttlMinutes: number,
): string;
export function inboundAccessText(
  locale: InboundAccessLocale | undefined,
  key: 'pairing' | 'unauthorized' | 'paired',
  code?: string,
  ttlMinutes?: number,
): string {
  const catalog = messages[locale ?? 'zh-CN'];
  if (key === 'pairing') return catalog.pairing(code ?? '', ttlMinutes ?? 10);
  return catalog[key];
}
