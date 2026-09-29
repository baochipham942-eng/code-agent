import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractLibraryText } from '../../../../src/host/services/library/libraryIngest';

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

  it('GBK 编码按 gb18030 解出正确中文', async () => {
    // 「名称,数量\n苹果,3\n」的 GBK 字节（feedback-inbox 样本 sample-gbk.csv）
    const gbk = Buffer.from('c3fbb3c62ccafdc1bf0ac6bbb9fb2c330a', 'hex');
    const file = write('c.csv', gbk);
    const result = await extractLibraryText(file);
    expect(result.text).toBe('名称,数量\n苹果,3\n');
    expect(result.text).not.toContain('�');
  });

  it('既非 UTF-8 也非 GB18030 的字节明确报错，不静默入库', async () => {
    // 0xFF 不是合法 UTF-8；0x81 0x20 是非法 GB18030 双字节序列
    const file = write('d.txt', Buffer.from([0x61, 0x81, 0x20, 0xff, 0xff]));
    await expect(extractLibraryText(file)).rejects.toThrow(/无法识别文件编码.*UTF-8/);
  });

  it('ASCII 主体夹坏字节（高字节稀疏）：同样明确报错，不把 U+FFFD 写进 sidecar', async () => {
    const ascii = Buffer.from('plain english line for the library, long enough to be sparse.\n'.repeat(8));
    for (const bad of [[0xff], [0x81, 0x20], [0x80]]) {
      const file = write('e.txt', Buffer.concat([ascii, Buffer.from(bad), ascii]));
      await expect(extractLibraryText(file)).rejects.toThrow(/无法识别文件编码.*UTF-8/);
    }
  });
});
