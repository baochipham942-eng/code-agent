import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';
import { LanCompanionServer } from '../../../../../src/host/services/companion/LanCompanionServer';
import { registerSpeechTranscriber } from '../../../../../src/host/services/capabilities/hostCapabilityPorts';
import type { SpeechTranscriber } from '../../../../../src/host/services/capabilities/hostCapabilityPorts';

const keys = vi.hoisted(() => ({ groq: undefined as string | undefined }));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: (provider: string) => provider === 'groq' ? keys.groq : undefined }),
}));

const { companionTranscriptionReadiness } = await import('../../../../../src/host/services/companion/transcriptionReadiness');

const transcriber: SpeechTranscriber = async () => ({ success: true, engine: 'groq', text: 'ok' });

function welcomeOf(): { transcription?: string; sessionlessTranscribe?: true } {
  const server = new LanCompanionServer({} as CompanionGateway, createIdentity());
  return (server as unknown as {
    welcome(device: { deviceId: string; scopeEpoch: number; scope: readonly string[] }): {
      transcription?: string; sessionlessTranscribe?: true;
    };
  }).welcome({ deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] });
}

describe('companionTranscriptionReadiness 三态', () => {
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

describe('LanCompanionServer welcome 把三态带进 binding', () => {
  afterEach(() => { keys.groq = undefined; });

  it('未注册转写器时 binding.transcription 是 not-installed', () => {
    const binding = welcomeOf();
    expect(binding.transcription).toBe('not-installed');
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
});
