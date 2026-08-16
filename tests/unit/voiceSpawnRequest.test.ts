import { describe, expect, it } from 'vitest';
import { fallbackVoiceTaskShortName } from '../../src/host/services/voice/voiceSpawnRequest';

describe('fallbackVoiceTaskShortName', () => {
  it('最多保留标题前 6 个字', () => {
    expect(fallbackVoiceTaskShortName('创建周报文件并打开')).toBe('创建周报文件');
  });
});
