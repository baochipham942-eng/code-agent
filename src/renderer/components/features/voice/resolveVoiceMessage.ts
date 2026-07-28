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
  return t.voice.messageByCode[entry.code] ?? entry.message;
}
