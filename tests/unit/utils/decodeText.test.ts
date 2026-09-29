import { describe, expect, it } from 'vitest';
import { decodeGb18030, decodeUtf8, TextDecodeError } from '../../../src/host/utils/decodeText';

// 「名称,数量\n苹果,3\n」的 GBK 字节（feedback-inbox 样本 sample-gbk.csv）
const GBK_SAMPLE = Buffer.from('c3fbb3c62ccafdc1bf0ac6bbb9fb2c330a', 'hex');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('decodeUtf8', () => {
  it('合法 UTF-8：原样、无坏序列', () => {
    expect(decodeUtf8(Buffer.from('名称,数量\n苹果,3\n'))).toEqual({
      text: '名称,数量\n苹果,3\n',
      encoding: 'utf-8',
      bom: false,
      invalidSequences: 0,
    });
  });

  it('BOM：剥掉并标记', () => {
    const decoded = decodeUtf8(Buffer.concat([BOM, Buffer.from('名称')]));
    expect(decoded).toMatchObject({ text: '名称', bom: true, invalidSequences: 0 });
  });

  it('含 1 个坏字节：invalidSequences=1，中文原样，坏字节成 U+FFFD', () => {
    const decoded = decodeUtf8(Buffer.concat([Buffer.from('名称'), Buffer.from([0x80]), Buffer.from('数量')]));
    expect(decoded.invalidSequences).toBe(1);
    expect(decoded.text).toBe('名称�数量');
    expect(decoded.bom).toBe(false);
  });

  it('带 BOM 且含坏字节：仍剥 BOM 并计数', () => {
    const decoded = decodeUtf8(Buffer.concat([BOM, Buffer.from('a'), Buffer.from([0xff]), Buffer.from('b')]));
    expect(decoded).toMatchObject({ text: 'a�b', bom: true, invalidSequences: 1 });
  });

  it('原文合法的 U+FFFD（EF BF BD）不计入坏序列', () => {
    const literal = decodeUtf8(Buffer.from('a�b'));
    expect(literal).toMatchObject({ text: 'a�b', invalidSequences: 0 });
    const mixed = decodeUtf8(Buffer.concat([Buffer.from('a�b'), Buffer.from([0x92]), Buffer.from('c')]));
    expect(mixed.invalidSequences).toBe(1);
  });

  it('GBK 样本按 UTF-8 解：有坏序列（不猜编码）', () => {
    expect(decodeUtf8(GBK_SAMPLE).invalidSequences).toBeGreaterThan(0);
  });

  it('截断的多字节序列 / 相邻坏字节按 WHATWG 口径逐处计数', () => {
    expect(decodeUtf8(Buffer.from([0x61, 0xe4, 0xb8])).invalidSequences).toBe(1); // 截断的「一」前缀
    expect(decodeUtf8(Buffer.from([0x80, 0x80, 0x80])).invalidSequences).toBe(3);
    expect(decodeUtf8(Buffer.from([0xc0, 0xaf])).invalidSequences).toBe(2); // overlong
    expect(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80])).invalidSequences).toBe(3); // surrogate
    expect(decodeUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80])).invalidSequences).toBe(4); // > U+10FFFF
  });

  it('随机字节：字节扫描计数 = 宽松解码产生的 U+FFFD 数（无原文 U+FFFD 时）', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 300; round++) {
      const bytes = Buffer.from(Array.from({ length: 1 + (next() % 40) }, () => next() % 256));
      if (bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))) continue;
      const replacements = [...new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)].filter((c) => c === '�').length;
      expect(decodeUtf8(bytes).invalidSequences, bytes.toString('hex')).toBe(replacements);
    }
  });
});

describe('decodeGb18030（调用方明确指定 GBK）', () => {
  it('解 GBK 样本', () => {
    expect(decodeGb18030(GBK_SAMPLE)).toBe('名称,数量\n苹果,3\n');
  });

  it('开头的 UTF-8 BOM 按误加 BOM 剥掉：BOM+GBK 样本 / BOM+短 GBK 都得原文，不出现「锘」', () => {
    expect(decodeGb18030(Buffer.concat([BOM, GBK_SAMPLE]))).toBe('名称,数量\n苹果,3\n');
    const short = decodeGb18030(Buffer.concat([BOM, Buffer.from('GBK'), Buffer.from('cec4bcfe', 'hex')]));
    expect(short).toBe('GBK文件');
  });

  it('非法字节抛 TextDecodeError', () => {
    expect(() => decodeGb18030(Buffer.from([0x61, 0x81, 0x20, 0x62]))).toThrow(TextDecodeError);
  });
});
