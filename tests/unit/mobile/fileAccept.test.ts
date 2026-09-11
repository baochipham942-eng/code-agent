import { describe, expect, it } from 'vitest';
import { companionFileMime } from '../../../src/shared/constants/companion';
import { COMPANION_PICKER_MIME_TYPES, FILE_ACCEPT, IMAGE_ACCEPT } from '../../../packages/mobile/src/platform/fileAccept';

// 选择器列表（手机侧）与放行真源（host 侧 FILE_EXT_MIME，扩展名权威）的漂移钉：
// 每个选择器类型必须能被 companionFileMime 放行，每个可放行类型必须能被选择器选中。
const EXT_FOR: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'application/json': '.json',
  'application/zip': '.zip', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
};

describe('companion picker accept lists', () => {
  it('every picker type is accepted by the host with its canonical extension', () => {
    for (const type of COMPANION_PICKER_MIME_TYPES) {
      expect(companionFileMime(`upload${EXT_FOR[type]}`, type)).toBe(type);
      expect(companionFileMime(`upload${EXT_FOR[type]}`, '')).toBe(type);
    }
  });

  it('every host-acceptable type is pickable', () => {
    for (const [type, ext] of Object.entries(EXT_FOR)) {
      // 若 host 的 FILE_EXT_MIME 新增类型而本表未更新，这里会先红——真源与选择器同步更新。
      expect(companionFileMime(`probe${ext}`, '')).toBe(type);
      expect(COMPANION_PICKER_MIME_TYPES).toContain(type);
    }
    expect(COMPANION_PICKER_MIME_TYPES.length).toBe(Object.keys(EXT_FOR).length);
  });

  it('image picker only accepts images, file picker covers the full set', () => {
    for (const type of IMAGE_ACCEPT.split(',')) expect(type.startsWith('image/')).toBe(true);
    expect(IMAGE_ACCEPT).toContain('image/heic');
    expect(FILE_ACCEPT.split(',').length).toBe(COMPANION_PICKER_MIME_TYPES.length);
  });
});
