// ============================================================================
// cua-driver 敏感按钮词表（ADR-088 二期 · FU3）
// 规格：docs/architecture/sensitive-step-handback.md §2「二期」。刻意从窄开始：
// 实测宽词表（CU_RISK_KEYWORD）把「upload」按钮误拦，窄词表在 15 条真实夹具标签上 0 误拦；
// 漏报（Submit / PIN / 确认订单 / 纯图标按钮）写进规格 §8，不靠加词掩盖。
// ============================================================================

/** 词表命中后交回卡的 kind；表序即多词同时命中时的优先序。 */
export type CuaSensitiveButtonKind = 'payment' | 'verification_code' | 'password';

/**
 * 词 → kind 的唯一映射表。cjk 词按子串匹配；latin 词按单词边界匹配（大小写不敏感），
 * 所以 repay / payload 不命中。接受的误拦：PayPal 式的 "Pay with …" 等含独立 pay 词的按钮。
 */
export const CUA_SENSITIVE_BUTTON_WORDS: ReadonlyArray<{
  kind: CuaSensitiveButtonKind;
  cjk: readonly string[];
  latin: readonly string[];
}> = [
  { kind: 'payment', cjk: ['支付', '付款', '结算', '提交订单'], latin: ['pay', 'checkout'] },
  { kind: 'verification_code', cjk: ['验证码'], latin: ['verification', '2FA', 'OTP'] },
  { kind: 'password', cjk: ['密码'], latin: ['password'] },
];
