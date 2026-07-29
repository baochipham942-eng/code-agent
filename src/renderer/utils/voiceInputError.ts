// ============================================================================
// 语音输入错误的渲染侧分类（现象 8）
//
// 背景：host 把上游网络失败（如 `Client network socket disconnected before secure
// TLS connection was established`）也塞进 SPEECH_NO_CHANNEL，UI 于是把网络抖动
// 引导到「去配置语音转文字」——改了也没用的页面。
//
// 判据纪律：
//   - 优先看 errorCode；
//   - 只能靠 message 时不枚举英文子串（那是漏洞制造机）——用「消息是否本地化」
//     区分：我们自己的用户文案全是中文，裸平台错误是纯 ASCII 技术串；
//   - 默认档要安全：未知错误给通用文案 + 重试，绝不掉进「去配置」那条。
// ============================================================================

export type VoiceInputErrorKind = 'mic-permission' | 'config' | 'network' | 'unknown';

/** 渲染侧自建的网络失败码：host 的错误码不可信（见上），连接类失败由 hook 显式打出。 */
export const VOICE_INPUT_NETWORK_ERROR_CODE = 'SPEECH_NETWORK';

/** 含 CJK 视为本地化人话，允许直出；纯 ASCII 技术串不许占主文案。 */
function isLocalizedMessage(message: string): boolean {
  return /[一-鿿]/.test(message);
}

export function classifyVoiceInputError(
  errorCode: string | null,
  message: string | null,
): VoiceInputErrorKind {
  if (errorCode === 'MICROPHONE_PERMISSION_DENIED') return 'mic-permission';
  if (errorCode === 'NOT_INITIALIZED') return 'config';
  if (errorCode === VOICE_INPUT_NETWORK_ERROR_CODE) return 'network';
  if (errorCode === 'SPEECH_NO_CHANNEL') {
    // host 复用了这个 code：本地化消息才是真「没有可用通道」，
    // 裸平台错误串（TLS/socket 之类）按网络失败处理。
    return message !== null && isLocalizedMessage(message) ? 'config' : 'network';
  }
  // 默认档：裸英文技术串按网络失败给文案，其余一律 unknown（通用文案 + 重试）。
  if (message !== null && message.length > 0 && !isLocalizedMessage(message)) return 'network';
  return 'unknown';
}
