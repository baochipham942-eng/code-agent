import type { CompanionTranscriptionReadiness } from '../../../shared/companion/lanProtocol';
import { getRegisteredSpeechTranscriber } from '../capabilities/hostCapabilityPorts';
import { getConfigService } from '../core/configService';

/**
 * 手机点麦克风前要知道的三态：能力没装 / 没配 Groq 密钥 / 可以转。
 * 未注册转写器时不碰 config（LAN 单测没有完整宿主）。
 */
export function companionTranscriptionReadiness(): CompanionTranscriptionReadiness {
  if (!getRegisteredSpeechTranscriber()) return 'not-installed';
  try {
    return getConfigService().getApiKey('groq') ? 'ready' : 'no-key';
  } catch {
    return 'no-key';
  }
}
