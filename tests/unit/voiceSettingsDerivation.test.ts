// 设置页「打断方式/灵敏度」→ turnDetection 推导门（B5）：运行时真源与 UI 三态不分叉。
import { describe, expect, it } from 'vitest';
import {
  deriveInterruptMode,
  deriveTurnDetection,
  deriveVadSensitivity,
} from '../../src/renderer/components/features/voice/voiceSettingsDerivation';

describe('deriveTurnDetection', () => {
  it('server_vad：灵敏度三档映射 threshold，其余参数跟随默认安全档', () => {
    expect(deriveTurnDetection('server_vad', 'high')).toEqual({
      type: 'server_vad',
      threshold: 0.3,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
    });
    expect(deriveTurnDetection('server_vad', 'medium')).toMatchObject({ threshold: 0.5 });
    expect(deriveTurnDetection('server_vad', 'low')).toMatchObject({ threshold: 0.7 });
  });

  it('push_to_talk / manual：turn_detection = null（手动 commit 模式，B6 前提）', () => {
    expect(deriveTurnDetection('push_to_talk', 'medium')).toBeNull();
    expect(deriveTurnDetection('manual', 'medium')).toBeNull();
  });
});

describe('反推（老配置没有 live.* 时按 turnDetection 形状推）', () => {
  it('turnDetection null → push_to_talk；server_vad → server_vad；未配置 → server_vad', () => {
    expect(deriveInterruptMode({ turnDetection: null })).toBe('push_to_talk');
    expect(deriveInterruptMode({ turnDetection: { type: 'server_vad' } })).toBe('server_vad');
    expect(deriveInterruptMode(undefined)).toBe('server_vad');
  });

  it('live.interrupt 优先于 turnDetection 形状', () => {
    expect(deriveInterruptMode({ turnDetection: null, live: { interrupt: 'manual' } })).toBe('manual');
  });

  it('灵敏度按 threshold 反推；live.vadSensitivity 优先', () => {
    expect(deriveVadSensitivity({ turnDetection: { type: 'server_vad', threshold: 0.3 } })).toBe('high');
    expect(deriveVadSensitivity({ turnDetection: { type: 'server_vad', threshold: 0.7 } })).toBe('low');
    expect(deriveVadSensitivity(undefined)).toBe('medium');
    expect(deriveVadSensitivity({ live: { vadSensitivity: 'low' }, turnDetection: { type: 'server_vad', threshold: 0.3 } })).toBe('low');
  });
});
