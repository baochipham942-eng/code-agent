// ============================================================================
// decodeText 判据：真 GBK vs 偶有坏字节的 UTF-8（N-READ-ENCODING 返修）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { decodeText, TextDecodeError } from '../../../src/host/utils/decodeText';

// 「用户名称,订单数量,备注…」多行 GBK 文本（python str.encode('gb18030')）
const GBK_PARAGRAPH = Buffer.from(
  'd3c3bba7c3fbb3c62cb6a9b5a5cafdc1bf2cb1b8d7a20ad5c5c8fd2c31322cc7ebbea1bfecb7a2bbf50ac0eecbc42c352cd0e8d2aabfaabedfb7a2c6b10acdf5cee52c382ccad5bbf5b5d8d6b7d2d1b8fcb8c4ceaac9cfbaa3cad0c6d6b6abd0c2c7f80a',
  'hex',
);
const UTF8_TEXT = '用户名称,订单数量,备注\n张三,12,请尽快发货\n李四,5,需要开具发票\n';

describe('decodeText', () => {
  it('长 GBK 文本判 gb18030', () => {
    const decoded = decodeText(GBK_PARAGRAPH);
    expect(decoded.encoding).toBe('gb18030');
    expect(decoded.text).toContain('收货地址已更改为上海市浦东新区');
    expect(decoded.invalidSequences).toBe(0);
  });

  it('UTF-8 夹单个坏字节：仍判 utf-8，中文完好，记 1 处坏序列', () => {
    const bytes = Buffer.concat([Buffer.from(UTF8_TEXT, 'utf-8'), Buffer.from([0x80]), Buffer.from('\n')]);
    const decoded = decodeText(bytes);
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text).toContain('张三,12,请尽快发货');
    expect(decoded.invalidSequences).toBe(1);
  });

  it('UTF-8 BOM 文件夹坏字节：BOM 仍被剥掉并记录', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名称,数量\n苹果,3', 'utf-8'), Buffer.from([0x80])]);
    const decoded = decodeText(bytes);
    expect(decoded).toMatchObject({ encoding: 'utf-8', bom: true, invalidSequences: 1 });
    expect(decoded.text.startsWith('名称')).toBe(true);
  });

  it('坏字节占大头（合法 UTF-8 只覆盖不到一半高字节、也不稀疏）不算 UTF-8：GB18030 也解不开则报错', () => {
    // 1 个合法中文 + 4 个坏字节 + 1 个 ASCII；0x83 0x20 也不是合法 GB18030
    const bytes = Buffer.from([0xe5, 0x90, 0x8d, 0x80, 0x81, 0x82, 0x83, 0x20]);
    expect(() => decodeText(bytes)).toThrow(TextDecodeError);
  });

  it('ASCII 主体夹孤立坏字节（0x92 / 0x80 / 0x81 0x20）：判 utf-8，ASCII 两侧保留', () => {
    const cases: Array<[Buffer, string]> = [
      [Buffer.concat([Buffer.from('function don'), Buffer.from([0x92]), Buffer.from('t() {}\n')]), 'function don\uFFFDt() {}\n'],
      [Buffer.concat([Buffer.from('hello '), Buffer.from([0x80]), Buffer.from(' world\n')]), 'hello \uFFFD world\n'],
      [Buffer.concat([Buffer.from('a = 1; '), Buffer.from([0x81, 0x20]), Buffer.from('b = 2;\n')]), 'a = 1; \uFFFD b = 2;\n'],
    ];
    for (const [bytes, expected] of cases) {
      const decoded = decodeText(bytes);
      expect(decoded.encoding).toBe('utf-8');
      expect(decoded.invalidSequences).toBeGreaterThan(0);
      expect(decoded.text).toBe(expected);
    }
  });

  it('ASCII 主体但高字节是 GB2312 双字节对：仍判 gb18030', () => {
    const bytes = Buffer.concat([
      Buffer.from('id,name,note\n1,'),
      Buffer.from('c3fbb3c6', 'hex'),
      Buffer.from(',keep the ascii part long enough so that high bytes stay sparse in this file\n'),
    ]);
    expect(decodeText(bytes)).toMatchObject({ encoding: 'gb18030', text: expect.stringContaining('1,名称,') });
  });

  it('短 UTF-8 夹单个坏字节（有效中文不足 4 倍）：仍判 utf-8，已合法的中文保留', () => {
    const cases: Array<[Buffer, string]> = [
      [Buffer.concat([Buffer.from('名称\n'), Buffer.from([0x80])]), '名称\n\uFFFD'],
      [Buffer.concat([Buffer.from('id=名称;ok'), Buffer.from([0x80])]), 'id=名称;ok\uFFFD'],
      [Buffer.concat([Buffer.from('苹果,3'), Buffer.from([0x80])]), '苹果,3\uFFFD'],
      [Buffer.concat([Buffer.from('名称'), Buffer.from([0xff, 0xff])]), '名称\uFFFD\uFFFD'],
    ];
    for (const [bytes, expected] of cases) {
      const decoded = decodeText(bytes);
      expect(decoded.encoding).toBe('utf-8');
      expect(decoded.text).toBe(expected);
    }
  });

  it('原文里合法的 U+FFFD 不计入坏序列', () => {
    const bytes = Buffer.concat([Buffer.from('你好世界\uFFFD'), Buffer.from([0x80])]);
    const decoded = decodeText(bytes);
    expect(decoded).toMatchObject({ encoding: 'utf-8', invalidSequences: 1 });
    expect(decoded.text).toBe('你好世界\uFFFD\uFFFD');
  });

  it('ASCII 正文含 é / ° 等 UTF-8 双字节（字节上与 GB2312 对无法区分）+ 坏字节：仍判 utf-8', () => {
    const cases: Array<[string, number[], string]> = [
      ['The café and the café are open today, please come by before the end of the week.\n', [0x80], 'caf\u00e9'],
      ['Temperatures: 25°C in the morning, 30°C in the afternoon, and 18°C at night.\n', [0x92], '25°C'],
      ['Temperatures: 25°C … 30°C don', [0x92, 0x74], '25°C'],
    ];
    for (const [text, bad, needle] of cases) {
      const decoded = decodeText(Buffer.concat([Buffer.from(text, 'utf-8'), Buffer.from(bad)]));
      expect(decoded.encoding).toBe('utf-8');
      expect(decoded.text).toContain(needle);
      expect(decoded.invalidSequences).toBeGreaterThan(0);
    }
  });

  it('同一段 ASCII 夹 E4 B8：带不带 UTF-8 BOM 判定一致', () => {
    const body = Buffer.concat([Buffer.from('x = 1; '.repeat(20)), Buffer.from([0xe4, 0xb8]), Buffer.from(' y = 2;\n'.repeat(20))]);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    expect(decodeText(bom).encoding).toBe(decodeText(body).encoding);
  });

  it('GBK 以 EF BB BF 三字节起头：GB18030 用原始 buffer，不剥 BOM', () => {
    const decoded = decodeText(Buffer.from('efbbbfa80a', 'hex'));
    expect(decoded).toMatchObject({ encoding: 'gb18030', bom: false });
    expect(decoded.text).toBe('锘卡\n');
  });
});
