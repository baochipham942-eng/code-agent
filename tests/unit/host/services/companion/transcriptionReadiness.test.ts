import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';
import { LanCompanionServer } from '../../../../../src/host/services/companion/LanCompanionServer';
import { registerCompanionDictation, registerSpeechTranscriber } from '../../../../../src/host/services/capabilities/hostCapabilityPorts';
import type { CompanionDictationPort, SpeechTranscriber } from '../../../../../src/host/services/capabilities/hostCapabilityPorts';

const keys = vi.hoisted(() => ({
  groq: undefined as string | undefined,
  dashscope: undefined as string | undefined,
  qwen: undefined as string | undefined,
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: (provider: string) => provider === 'groq' ? keys.groq
      : provider === 'dashscope' ? keys.dashscope
      : provider === 'qwen' ? keys.qwen : undefined,
  }),
}));

const { companionDictationReadiness, companionTranscriptionReadiness } = await import('../../../../../src/host/services/companion/transcriptionReadiness');

const transcriber: SpeechTranscriber = async () => ({ success: true, engine: 'groq', text: 'ok' });
const dictationPort: CompanionDictationPort = {
  open: async () => ({ ok: true, streamId: 's', sampleRate: 16000 }),
  audio: () => ({ ok: true, events: [] }),
  stop: async () => ({ ok: true, events: [] }),
  release: () => {},
  releaseAll: () => {},
};

function welcomeOf(): { transcription?: string; dictation?: true; dictationTranscription?: string; sessionlessTranscribe?: true } {
  const server = new LanCompanionServer({} as CompanionGateway, createIdentity());
  return (server as unknown as {
    welcome(device: { deviceId: string; scopeEpoch: number; scope: readonly string[] }): {
      transcription?: string; dictation?: true; dictationTranscription?: string; sessionlessTranscribe?: true;
    };
  }).welcome({ deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] });
}

beforeEach(() => {
  // getDashscopeApiKey 读 env 优先：钉成空串，别让开发机上的 DASHSCOPE_API_KEY 漏进判据。
  vi.stubEnv('DASHSCOPE_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('companionTranscriptionReadiness 三态（分段转写，只看 Groq）', () => {
  afterEach(() => {
    keys.groq = undefined;
  });

  it('未注册转写器 → not-installed', () => {
    expect(companionTranscriptionReadiness()).toBe('not-installed');
  });

  it('注册了但无 groq key → no-key', () => {
    const unregister = registerSpeechTranscriber(transcriber);
    try {
      keys.groq = undefined;
      expect(companionTranscriptionReadiness()).toBe('no-key');
    } finally { void unregister(); }
  });

  it('有 groq key → ready', () => {
    const unregister = registerSpeechTranscriber(transcriber);
    try {
      keys.groq = 'gsk_test';
      expect(companionTranscriptionReadiness()).toBe('ready');
    } finally { void unregister(); }
  });
});

describe('companionDictationReadiness 三态（实时听写，只看百炼）', () => {
  afterEach(() => {
    keys.dashscope = undefined;
    keys.qwen = undefined;
  });

  it('未注册听写口 → not-installed', () => {
    expect(companionDictationReadiness()).toBe('not-installed');
  });

  it('注册了但没配百炼 → no-key（有 Groq 也不算——那条是分段转写的钥匙）', () => {
    const unregister = registerCompanionDictation(dictationPort);
    try {
      keys.groq = 'gsk_test';
      expect(companionDictationReadiness()).toBe('no-key');
    } finally { void unregister(); }
  });

  it('只配百炼（无 Groq）→ ready', () => {
    const unregister = registerCompanionDictation(dictationPort);
    try {
      keys.dashscope = 'sk_test';
      expect(companionDictationReadiness()).toBe('ready');
    } finally { void unregister(); }
  });

  it('百炼配在 qwen 槽位同样算 → ready', () => {
    const unregister = registerCompanionDictation(dictationPort);
    try {
      keys.qwen = 'sk_test';
      expect(companionDictationReadiness()).toBe('ready');
    } finally { void unregister(); }
  });
});

describe('LanCompanionServer welcome 把三态带进 binding', () => {
  afterEach(() => {
    keys.groq = undefined;
    keys.dashscope = undefined;
    keys.qwen = undefined;
  });

  it('未注册转写器时 binding.transcription 是 not-installed，也不广告 dictation', () => {
    const binding = welcomeOf();
    expect(binding.transcription).toBe('not-installed');
    expect(binding.dictation).toBeUndefined();
    expect(binding.dictationTranscription).toBeUndefined();
    expect(binding.sessionlessTranscribe).toBe(true);
  });

  it('注册了但无 groq key 时 binding.transcription 是 no-key', () => {
    const unregister = registerSpeechTranscriber(transcriber);
    try {
      keys.groq = undefined;
      expect(welcomeOf().transcription).toBe('no-key');
    } finally { void unregister(); }
  });

  it('有 groq key 时 binding.transcription 是 ready', () => {
    const unregister = registerSpeechTranscriber(transcriber);
    try {
      keys.groq = 'gsk_test';
      expect(welcomeOf().transcription).toBe('ready');
    } finally { void unregister(); }
  });

  it('广告 dictation 时随之下发百炼三态：只配百炼（分段 no-key）的电脑也是 dictationTranscription=ready', () => {
    const unregisterInput = registerSpeechTranscriber(transcriber);
    const unregisterDictation = registerCompanionDictation(dictationPort);
    try {
      keys.groq = undefined;
      keys.dashscope = 'sk_test';
      expect(welcomeOf()).toMatchObject({ transcription: 'no-key', dictation: true, dictationTranscription: 'ready' });
      keys.dashscope = undefined;
      expect(welcomeOf()).toMatchObject({ dictation: true, dictationTranscription: 'no-key' });
    } finally { void unregisterDictation(); void unregisterInput(); }
  });
});
