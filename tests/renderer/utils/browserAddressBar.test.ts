import { describe, expect, it } from 'vitest';
import { normalizeBrowserAddressInput } from '../../../src/renderer/utils/browserAddressBar';

describe('normalizeBrowserAddressInput（地址栏输入归一化）', () => {
  it('无协议前缀的域名补 https://', () => {
    expect(normalizeBrowserAddressInput('example.com')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
    expect(normalizeBrowserAddressInput('example.com/path?q=1')).toEqual({
      ok: true,
      url: 'https://example.com/path?q=1',
    });
  });

  it('带前后空白的输入先裁剪再归一化', () => {
    expect(normalizeBrowserAddressInput('  example.com  ')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
  });

  it('已有 http(s) 协议的原样通过', () => {
    expect(normalizeBrowserAddressInput('http://example.com/a')).toEqual({
      ok: true,
      url: 'http://example.com/a',
    });
    expect(normalizeBrowserAddressInput('https://example.com/a b'.replace(' b', '%20b'))).toEqual({
      ok: true,
      url: 'https://example.com/a%20b',
    });
  });

  it('localhost 与 IPv4 视为合法主机', () => {
    expect(normalizeBrowserAddressInput('localhost:3000')).toEqual({
      ok: true,
      url: 'https://localhost:3000/',
    });
    expect(normalizeBrowserAddressInput('127.0.0.1:8080/preview')).toEqual({
      ok: true,
      url: 'https://127.0.0.1:8080/preview',
    });
  });

  it('明显是搜索词的判无效（本单不做搜索）', () => {
    expect(normalizeBrowserAddressInput('hello world').ok).toBe(false);
    expect(normalizeBrowserAddressInput('帮我查天气').ok).toBe(false);
    // 单词无点：更像搜索词而不是网址
    expect(normalizeBrowserAddressInput('news').ok).toBe(false);
  });

  it('空输入与非 http(s) 协议判无效', () => {
    expect(normalizeBrowserAddressInput('').ok).toBe(false);
    expect(normalizeBrowserAddressInput('   ').ok).toBe(false);
    expect(normalizeBrowserAddressInput('ftp://example.com').ok).toBe(false);
    expect(normalizeBrowserAddressInput('file:///etc/hosts').ok).toBe(false);
  });

  it('无协议的非法主机判无效', () => {
    expect(normalizeBrowserAddressInput('foo bar.com').ok).toBe(false);
    expect(normalizeBrowserAddressInput('http://').ok).toBe(false);
  });
});
