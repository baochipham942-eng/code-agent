// @vitest-environment jsdom
// 实时语音 spike 挂件的 dev-only 门控：生产构建即使开关被注入也不放行。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_DEV_FLAG_KEY } from '@shared/constants';
import { isVoiceSpikeEnabled } from '../../../src/renderer/components/features/voice/voiceSpikeFlag';

describe('isVoiceSpikeEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
    delete (window as unknown as Record<string, unknown>).__CODE_AGENT_VOICE_SPIKE__;
  });

  it('生产构建下 localStorage 开关也不放行', () => {
    vi.stubEnv('DEV', false);
    window.localStorage.setItem(VOICE_DEV_FLAG_KEY, '1');
    expect(isVoiceSpikeEnabled()).toBe(false);
  });

  it('生产构建下 host 注入的全局开关也不放行', () => {
    vi.stubEnv('DEV', false);
    (window as unknown as Record<string, unknown>).__CODE_AGENT_VOICE_SPIKE__ = true;
    expect(isVoiceSpikeEnabled()).toBe(false);
  });

  it('dev 构建下 localStorage 开关打开放行', () => {
    vi.stubEnv('DEV', true);
    window.localStorage.setItem(VOICE_DEV_FLAG_KEY, '1');
    expect(isVoiceSpikeEnabled()).toBe(true);
  });

  it('dev 构建下默认关闭', () => {
    vi.stubEnv('DEV', true);
    expect(isVoiceSpikeEnabled()).toBe(false);
  });
});
