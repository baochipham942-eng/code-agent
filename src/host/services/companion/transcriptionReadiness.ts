import type { CompanionTranscriptionReadiness } from '../../../shared/companion/lanProtocol';
import { getRegisteredCompanionDictation, getRegisteredSpeechTranscriber } from '../capabilities/hostCapabilityPorts';
import { getConfigService } from '../core/configService';
import { getDashscopeApiKey } from '../media/imageGenerationService';

/**
 * 手机点麦克风前要知道的三态。分段转写（voice.transcribe）只走 Groq 密钥；
 * 实时听写是另一条路，用百炼密钥——两态分开算，手机预检按它将走的那条判
 * （N-MOBILE-VOICE-TRANSCRIBE-FIX-R6：只配百炼的电脑，实时听写不能被 Groq 的 no-key 拦死）。
 * 未注册对应能力时不碰 config（LAN 单测没有完整宿主）。
 */
export function companionTranscriptionReadiness(): CompanionTranscriptionReadiness {
  if (!getRegisteredSpeechTranscriber()) return 'not-installed';
  try {
    return getConfigService().getApiKey('groq') ? 'ready' : 'no-key';
  } catch {
    return 'no-key';
  }
}

/** 实时听写三态：与 companionDictationRelay.open 同一把钥匙（百炼 DashScope，env 优先），判定不漂。 */
export function companionDictationReadiness(): CompanionTranscriptionReadiness {
  if (!getRegisteredCompanionDictation()) return 'not-installed';
  try {
    return getDashscopeApiKey() ? 'ready' : 'no-key';
  } catch {
    return 'no-key';
  }
}
