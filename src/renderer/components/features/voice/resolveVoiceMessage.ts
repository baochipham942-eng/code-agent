// ============================================================================
// resolveVoiceMessage —— host 发来的提示/错误按 code 查 i18n
// ============================================================================
// host 里那几条 message 是硬编码中文，直接显示会让英文用户看到中文。
// 文案的家在 renderer 的 i18n，host 只负责说「出了哪件事」（code）。
//
// 键集由 VoiceMessageCode 定型（i18n 侧 `satisfies Record<VoiceMessageCode, string>`），
// 所以这里不需要运行时兜底判断——漏一条是编译错误。message 仍保留：
// 真出现表外 code（如 host 与 renderer 版本不一致）时，显示原文比显示空白强。
// ============================================================================

import type { Translations } from '../../../i18n/zh';
import type { VoiceCallError } from '../../../stores/voiceCallStore';

export function resolveVoiceMessage(t: Translations, entry: VoiceCallError): string {
  // `{reason}` 占位符：少数几条提示必须带上游给的真实原因（如派活失败的
  // 「服务认证异常」）——只说「失败了」等于没说。原因文本来自上游/执行侧，
  // 没法进 i18n 表，所以文案框架在 i18n、原因由 message 填。
  // 同 t.voice.work.remaining 的 `{n}` 先例；没有占位符的 code 不受影响。
  return (t.voice.messageByCode[entry.code] ?? entry.message).replace('{reason}', entry.message);
}

/** 错误条的 title：有原始详情时只放在悬停层，没有时沿用主文案。 */
export function resolveVoiceErrorTitle(t: Translations, entry: VoiceCallError): string {
  return entry.detail?.trim() || resolveVoiceMessage(t, entry);
}
