import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { annotateSummaryWithEncodingNote, extractLibraryText } from '../../../../src/host/services/library/libraryIngest';

describe('extractLibraryText 文本编码识别', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-encoding-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, bytes: Buffer): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, bytes);
    return file;
  }

  it('UTF-8 原样读取', async () => {
    const file = write('a.csv', Buffer.from('名称,数量\n苹果,3\n', 'utf-8'));
    const result = await extractLibraryText(file);
    expect(result.text).toBe('名称,数量\n苹果,3\n');
  });

  it('UTF-8 带 BOM 时剥掉 BOM', async () => {
    const file = write('b.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名称,数量\n苹果,3\n', 'utf-8')]));
    const result = await extractLibraryText(file);
    expect(result.text).toBe('名称,数量\n苹果,3\n');
  });

  it('GBK 编码按 gb18030 解出正确中文，并带「按 GBK 识别」提示', async () => {
    // 「名称,数量\n苹果,3\n」的 GBK 字节（feedback-inbox 样本 sample-gbk.csv）
    const gbk = Buffer.from('c3fbb3c62ccafdc1bf0ac6bbb9fb2c330a', 'hex');
    const file = write('c.csv', gbk);
    const result = await extractLibraryText(file);
    expect(result.text).toBe('名称,数量\n苹果,3\n');
    expect(result.text).not.toContain('\uFFFD');
    expect(result.note).toContain('按 GBK 识别');
    expect(result.note).toContain('另存为 UTF-8');
  });

  it('合法 UTF-8 / BOM 无编码提示', async () => {
    expect((await extractLibraryText(write('a2.csv', Buffer.from('名称\n')))).note).toBeUndefined();
    expect((await extractLibraryText(write('b2.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名称\n')])))).note).toBeUndefined();
  });

  it('既非 UTF-8 也非 GB18030 的字节明确报错，不静默入库', async () => {
    // 0xFF 不是合法 UTF-8；0x81 0x20 是非法 GB18030 双字节序列
    const file = write('d.txt', Buffer.from([0x61, 0x81, 0x20, 0xff, 0xff]));
    await expect(extractLibraryText(file)).rejects.toThrow(/无法识别文件编码.*UTF-8/);
  });
});

describe('annotateSummaryWithEncodingNote', () => {
  const note = '按 GBK 识别；如内容显示乱码，请另存为 UTF-8 后重新导入';

  it('无摘要时只放标注；有摘要时标注在前', () => {
    expect(annotateSummaryWithEncodingNote(undefined, note)).toContain(note);
    const withSummary = annotateSummaryWithEncodingNote('季度销售', note);
    expect(withSummary).toContain(note);
    expect(withSummary?.endsWith('季度销售')).toBe(true);
  });

  it('重复学习幂等；后来变成 UTF-8 则清掉旧标注', () => {
    const once = annotateSummaryWithEncodingNote('季度销售', note);
    expect(annotateSummaryWithEncodingNote(once, note)).toBe(once);
    expect(annotateSummaryWithEncodingNote(once, undefined)).toBe('季度销售');
    expect(annotateSummaryWithEncodingNote(annotateSummaryWithEncodingNote(undefined, note), undefined)).toBeUndefined();
  });

  it('摘要接近 2000 字上限：标注保留、只截用户原文，总长不超预算', () => {
    for (const len of [1959, 1960, 1990, 2000, 5000]) {
      const long = annotateSummaryWithEncodingNote('长'.repeat(len), note)!;
      expect(long.length, `len=${len}`).toBeLessThanOrEqual(2000);
      expect(long).toContain(note);
      if (len >= 1960) expect(long.endsWith('…')).toBe(true);
      else expect(long.endsWith('长')).toBe(true);
    }
    // 截断后的结果再学一次仍幂等
    const once = annotateSummaryWithEncodingNote('长'.repeat(5000), note);
    expect(annotateSummaryWithEncodingNote(once, note)).toBe(once);
  });

  it('无标注且无提示：摘要原样', () => {
    expect(annotateSummaryWithEncodingNote('季度销售', undefined)).toBe('季度销售');
    expect(annotateSummaryWithEncodingNote(undefined, undefined)).toBeUndefined();
  });
});
