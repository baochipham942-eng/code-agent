import type { VoiceInterruptClassification } from '../../../shared/contract/voice';

export interface VoiceInterruptEvidence {
  assistantPlaying: boolean;
  durationMs?: number;
  text: string;
  stage: 'partial' | 'final';
}

export interface VoiceInterruptDecision {
  classification: VoiceInterruptClassification;
  terminal: boolean;
  cancel: boolean;
  shouldRespond: boolean;
}

const ACKNOWLEDGEMENT = /^(?:嗯+|唔+|啊+|哦+|对(?:的)?|是(?:的)?|好(?:的)?|行(?:的)?|可以|没错|知道了|好(?:的)?知道了|明白了|收到(?:了)?|ok|okay|yes)(?:啊|呀|呢)?$/i;
const SUPPLEMENT = /^(?:还有|另外|补充|再加|以及|顺便|刚才漏了|再说一点|我再补一句)/;
const EXPLICIT_INTERRUPT = /^(?:停|停下|先停|等等|等一下|别说|别讲|不对|打断一下|换一个|换个话题|改成|改为|不要挂断|别挂断|挂断|结束通话|先这样)/;

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, '').replace(/[，,。.!！？?]+$/g, '');
}

function isAcknowledgement(text: string): boolean {
  return ACKNOWLEDGEMENT.test(text.replace(/[，,。.!！]/g, ''));
}

export function decideVoiceInterrupt(evidence: VoiceInterruptEvidence): VoiceInterruptDecision {
  const text = normalized(evidence.text);
  if (!evidence.assistantPlaying) {
    return {
      classification: 'no_playback',
      terminal: evidence.stage === 'final',
      cancel: false,
      shouldRespond: evidence.stage === 'final' && !!text,
    };
  }
  if (EXPLICIT_INTERRUPT.test(text)) {
    return {
      classification: 'true_interrupt',
      terminal: true,
      cancel: true,
      shouldRespond: evidence.stage === 'final',
    };
  }
  if (evidence.stage === 'partial') {
    return { classification: 'pending', terminal: false, cancel: false, shouldRespond: false };
  }
  if (!text) {
    return { classification: 'background', terminal: true, cancel: false, shouldRespond: false };
  }
  if (isAcknowledgement(text)) {
    return { classification: 'acknowledgement', terminal: true, cancel: false, shouldRespond: false };
  }
  if (SUPPLEMENT.test(text)) {
    return { classification: 'supplement', terminal: true, cancel: false, shouldRespond: true };
  }
  if ((evidence.durationMs ?? 0) < 300 && text.length <= 2) {
    return { classification: 'short_fragment', terminal: true, cancel: false, shouldRespond: false };
  }
  return { classification: 'true_interrupt', terminal: true, cancel: true, shouldRespond: true };
}

/** 告别窗里附和不算反悔，明确“不要挂断”等语义必须解除挂断武装。 */
export function shouldDisarmHangup(text: string): boolean {
  const value = normalized(text);
  if (!value || isAcknowledgement(value)) return false;
  return value.length > 2 || EXPLICIT_INTERRUPT.test(value);
}
