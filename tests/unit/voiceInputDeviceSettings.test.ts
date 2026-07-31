import { describe, expect, it } from 'vitest';
import { normalizeVoiceInputDevice } from '../../src/shared/voiceInputDevice';

describe('voice.inputDevice 设置读取口', () => {
  it('缺省配置使用系统默认设备', () => {
    expect(normalizeVoiceInputDevice(undefined)).toBeUndefined();
  });

  it('接受 label-only，并清理首尾空白', () => {
    expect(normalizeVoiceInputDevice({ label: '  USB 麦克风  ' })).toEqual({
      label: 'USB 麦克风',
    });
  });

  it('接受完整配置', () => {
    expect(normalizeVoiceInputDevice({
      label: 'Studio Mic',
      webDeviceId: ' web-device-42 ',
    })).toEqual({
      label: 'Studio Mic',
      webDeviceId: 'web-device-42',
    });
  });

  it.each([
    null,
    'Studio Mic',
    [],
    {},
    { label: '' },
    { label: 42 },
    { label: '   ' },
  ])('垃圾形状 %j fail-open 为系统默认', (value) => {
    expect(normalizeVoiceInputDevice(value)).toBeUndefined();
  });

  it('损坏的 webDeviceId 不拖垮有效 label', () => {
    expect(normalizeVoiceInputDevice({ label: 'Studio Mic', webDeviceId: 42 })).toEqual({
      label: 'Studio Mic',
    });
  });
});
