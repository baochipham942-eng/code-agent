// 设置页「打断方式/灵敏度」→ turnDetection 推导门（B5）：运行时真源与 UI 三态不分叉。
import { describe, expect, it } from 'vitest';
import {
  deriveInterruptMode,
  deriveTurnDetection,
  deriveVadSensitivity,
  normalizeInterruptMode,
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

  it('点按说话：turn_detection = null（手动 commit 模式，B6 前提）', () => {
        expect(deriveTurnDetection('manual', 'medium')).toBeNull();
  });
});

describe('反推（老配置没有 live.* 时按 turnDetection 形状推）', () => {
  it('turnDetection null → manual；server_vad → server_vad；未配置 → server_vad', () => {
    expect(deriveInterruptMode({ turnDetection: null })).toBe('manual');
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

// 2026-07-27 删「按住说话」档：它相对「点按说话」只多一条松手必关麦，
// 代价是整通电话手被按在按钮上。已经存了这个值的用户必须被迁走——
// 留在运行时就是一个没有 UI 的档位（设置页选不到，却在生效）。
describe('删档迁移', () => {
  it('历史 push_to_talk 迁到 manual', () => {
    expect(normalizeInterruptMode('push_to_talk')).toBe('manual');
    expect(deriveInterruptMode({ live: { interrupt: 'push_to_talk' as never } })).toBe('manual');
  });

  it('server_vad 与未配置不受影响', () => {
    expect(normalizeInterruptMode('server_vad')).toBe('server_vad');
    expect(normalizeInterruptMode(undefined)).toBe('server_vad');
  });
});
