// ============================================================================
// music 服务不可用 tool-row 文案 tests — N-MEDIA-GEN-MUSIC-FALLBACK
//
// MUSIC_SERVICE_UNAVAILABLE / MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE 两个 code 的
// zh/en 摘要与详情：{alternatives} 由 metadata.alternatives 填入；字段缺失时占位符
// 原样保留（interpolateCodeCopy 的降级契约），绝不出现 undefined。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { humanizeToolError } from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const RAW_ERROR = [
  '0/1 saved',
  'per_request [{"index":1,"status":"failed","error":"音乐生成失败 HTTP 410"}]',
  'The default MiniMax music service is unavailable (HTTP 410). Do not retry. Configured music models you can pass as `model`: custom-x:some-music.',
].join('\n');

describe('music service unavailable tool-row copy', () => {
  it('MUSIC_SERVICE_UNAVAILABLE fills {alternatives} into the zh summary/detail', () => {
    const humanized = humanizeToolError(RAW_ERROR, 'music_generate', zh, {
      code: 'MUSIC_SERVICE_UNAVAILABLE',
      alternatives: 'custom-x:some-music',
    });
    expect(humanized?.summary).toBe('默认音乐服务（MiniMax）已不可用');
    expect(humanized?.detail).toBe('可改用已配置的音乐模型：custom-x:some-music');
  });

  it('MUSIC_SERVICE_UNAVAILABLE mirrors the zh copy in en', () => {
    const humanized = humanizeToolError(RAW_ERROR, 'music_generate', en, {
      code: 'MUSIC_SERVICE_UNAVAILABLE',
      alternatives: 'custom-x:some-music',
    });
    expect(humanized?.summary).toBe('The default music service (MiniMax) is unavailable');
    expect(humanized?.detail).toBe('Use a configured music model instead: custom-x:some-music');
  });

  it('keeps the {alternatives} placeholder when metadata lacks the field', () => {
    const humanized = humanizeToolError(RAW_ERROR, 'music_generate', zh, {
      code: 'MUSIC_SERVICE_UNAVAILABLE',
    });
    expect(humanized?.summary).toBe('默认音乐服务（MiniMax）已不可用');
    expect(humanized?.detail).toBe('可改用已配置的音乐模型：{alternatives}');
    expect(humanized?.detail).not.toContain('undefined');
  });

  it('MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE shows the no-way-out copy in zh and en', () => {
    const zhCopy = humanizeToolError(RAW_ERROR, 'music_generate', zh, {
      code: 'MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE',
    });
    expect(zhCopy?.summary).toBe('当前没有可用的音乐服务');
    expect(zhCopy?.detail).toBe('默认的 MiniMax 音乐接口已对新账户关闭；可在设置的模型页添加支持生成音乐的模型后再试');
    const enCopy = humanizeToolError(RAW_ERROR, 'music_generate', en, {
      code: 'MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE',
    });
    expect(enCopy?.summary).toBe('No music service is currently available');
    expect(enCopy?.detail).toBe('The default MiniMax music API is closed to new accounts; add a music-capable model in Settings → Models, then try again');
  });
});
