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

  it('坏字节占比过高（有效中文不足 4 倍）不算 UTF-8：回落 GB18030 或报错', () => {
    // 1 个合法中文 + 2 个坏字节，且不是合法 GB18030
    const bytes = Buffer.from([0xe5, 0x90, 0x8d, 0x80, 0x20, 0x81, 0x20]);
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

  it('GBK 以 EF BB BF 三字节起头：GB18030 用原始 buffer，不剥 BOM', () => {
    const decoded = decodeText(Buffer.from('efbbbfa80a', 'hex'));
    expect(decoded).toMatchObject({ encoding: 'gb18030', bom: false });
    expect(decoded.text).toBe('锘卡\n');
  });
});
