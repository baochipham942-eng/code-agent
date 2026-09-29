// ============================================================================
// N-READ-ENCODING — Read 默认 UTF-8 + 坏字节告知 + encoding 参数；Edit/Write/Append 对非法 UTF-8 已存在文件拒写（不猜编码）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { computeContentDigest, fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';

vi.mock('../../../../../src/host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { readModule } from '../../../../../src/host/tools/modules/file/read';
import { editModule } from '../../../../../src/host/tools/modules/file/multiEdit';
import { writeModule } from '../../../../../src/host/tools/modules/file/write';
import { appendModule } from '../../../../../src/host/tools/modules/file/append';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    workingDir,
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

// 「名称,数量\n苹果,3\n」的 GBK 字节（feedback-inbox 样本 sample-gbk.csv）
const GBK_BYTES = Buffer.from('c3fbb3c62ccafdc1bf0ac6bbb9fb2c330a', 'hex');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOTICE_MARK = '不是合法 UTF-8 的字节';

describe('N-READ-ENCODING', () => {
  let tmpDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-encoding-'));
    ctx = makeCtx(tmpDir);
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function read(file: string, extra: Record<string, unknown> = {}) {
    return (await readModule.createHandler()).execute({ file_path: file, ...extra }, ctx, allowAll);
  }
  async function readOutput(file: string, extra: Record<string, unknown> = {}): Promise<string> {
    const result = await read(file, extra);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.output;
  }
  async function edit(file: string, oldText: string, newText: string) {
    return (await editModule.createHandler()).execute(
      { file_path: file, edits: [{ old_text: oldText, new_text: newText }] },
      ctx,
      allowAll,
    );
  }
  async function write(file: string, content: string) {
    return (await writeModule.createHandler()).execute({ file_path: file, content }, ctx, allowAll);
  }
  async function append(file: string, content: string) {
    return (await appendModule.createHandler()).execute({ file_path: file, content }, ctx, allowAll);
  }

  describe('Read', () => {
    it('合法 UTF-8：原样读出，无告知行', async () => {
      const file = path.join(tmpDir, 'a.csv');
      await fs.writeFile(file, '名称,数量\n苹果,3\n', 'utf-8');
      const output = await readOutput(file);
      expect(output).toContain('苹果,3');
      expect(output).not.toContain(NOTICE_MARK);
    });

    it('UTF-8 BOM：读出中文，无告知行', async () => {
      const file = path.join(tmpDir, 'b.csv');
      await fs.writeFile(file, Buffer.concat([UTF8_BOM, Buffer.from('名称,数量\n苹果,3\n', 'utf-8')]));
      const output = await readOutput(file);
      expect(output).toContain('名称,数量');
      expect(output).not.toContain(NOTICE_MARK);
    });

    it('默认读 GBK 样本：给出告知行（N>0）并指引 encoding: gbk', async () => {
      const file = path.join(tmpDir, 'c.csv');
      await fs.writeFile(file, GBK_BYTES);
      const output = await readOutput(file);
      expect(output).toMatch(/此文件有 [1-9]\d* 处不是合法 UTF-8 的字节/);
      expect(output).toContain("encoding: 'gbk'");
    });

    it("encoding:'gbk' 读 GBK 样本：中文正确、无告知行", async () => {
      const file = path.join(tmpDir, 'c2.csv');
      await fs.writeFile(file, GBK_BYTES);
      const output = await readOutput(file, { encoding: 'gbk' });
      expect(output).toContain('名称,数量');
      expect(output).toContain('苹果,3');
      expect(output).not.toContain('\uFFFD');
      expect(output).not.toContain(NOTICE_MARK);
    });

    it("encoding:'gbk' 遇非法 GB18030 字节：明确报错", async () => {
      const file = path.join(tmpDir, 'bad-gbk.txt');
      await fs.writeFile(file, Buffer.from([0x61, 0x81, 0x20, 0x62]));
      const result = await read(file, { encoding: 'gbk' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('GBK');
    });

    it('未知 encoding 值：报错', async () => {
      const file = path.join(tmpDir, 'x.txt');
      await fs.writeFile(file, 'abc');
      const result = await read(file, { encoding: 'latin1' });
      expect(result.ok).toBe(false);
    });

    it('含坏字节的中文 UTF-8：中文原样、有告知行、不出现 GBK 乱码', async () => {
      const file = path.join(tmpDir, 'zh-bad.txt');
      await fs.writeFile(file, Buffer.concat([Buffer.from('名称\n', 'utf-8'), Buffer.from([0x80]), Buffer.from('\n数量\n', 'utf-8')]));
      const output = await readOutput(file);
      expect(output).toContain('名称');
      expect(output).toContain('数量');
      expect(output).toContain(NOTICE_MARK);
      expect(output).toContain('此文件有 1 处');
    });

    it.each([
      ['café + 0x80', Buffer.concat([Buffer.from('a café menu\n', 'utf-8'), Buffer.from([0x80]), Buffer.from(' end\n')]), 'café'],
      ['25°C + 0x92', Buffer.concat([Buffer.from('temp 25°C now\n', 'utf-8'), Buffer.from([0x92]), Buffer.from(' end\n')]), '25°C'],
      ['don\\x92t', Buffer.concat([Buffer.from('don'), Buffer.from([0x92]), Buffer.from('t stop, é ° ok\n', 'utf-8')]), 'é ° ok'],
    ])('%s：é/° 原样、含告知行、绝不出现「茅」「掳」「抰」', async (_name, bytes, expected) => {
      const file = path.join(tmpDir, 'mix.txt');
      await fs.writeFile(file, bytes);
      const output = await readOutput(file);
      expect(output).toContain(expected);
      expect(output).toContain(NOTICE_MARK);
      for (const garbage of ['茅', '掳', '抰']) expect(output).not.toContain(garbage);
    });

    it('digest 按原始字节计算（GBK 文件 Read 后 Edit 的外改检测口径一致）', async () => {
      const file = path.join(tmpDir, 'digest.csv');
      await fs.writeFile(file, GBK_BYTES);
      const output = await readOutput(file);
      expect(output.startsWith(`Read version digest: ${computeContentDigest(GBK_BYTES)}\n`)).toBe(true);
    });
  });

  describe('非法 UTF-8 的已存在文件：Edit / Write / Append 拒写，文件字节不变', () => {
    const cases: Array<[string, Buffer]> = [
      ['GBK 样本', GBK_BYTES],
      ['含坏字节的 UTF-8', Buffer.concat([Buffer.from('名称\n苹果,3\n', 'utf-8'), Buffer.from([0x80]), Buffer.from('\n')])],
    ];

    it.each(cases)('Edit 拒绝：%s', async (_name, bytes) => {
      const file = path.join(tmpDir, 'e.csv');
      await fs.writeFile(file, bytes);
      await readOutput(file);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('not valid UTF-8');
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it.each(cases)('Write 覆盖拒绝：%s', async (_name, bytes) => {
      const file = path.join(tmpDir, 'f.csv');
      await fs.writeFile(file, bytes);
      await readOutput(file);
      const result = await write(file, '名称,数量\n香蕉,3\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('not valid UTF-8');
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it.each(cases)('Append 拒绝：%s', async (_name, bytes) => {
      const file = path.join(tmpDir, 'g.csv');
      await fs.writeFile(file, bytes);
      const result = await append(file, '香蕉,4\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('not valid UTF-8');
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it('新建文件照旧 UTF-8', async () => {
      const file = path.join(tmpDir, 'new.csv');
      const result = await write(file, '名称\n香蕉\n');
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('名称\n香蕉\n');
    });
  });

  describe('合法 UTF-8 往返回归（与 main 一致）', () => {
    it('UTF-8 文件 Read → Edit 生效，其余字节不变', async () => {
      const file = path.join(tmpDir, 'h.csv');
      await fs.writeFile(file, '名称,数量\n苹果,3\n', 'utf-8');
      await readOutput(file);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('名称,数量\n香蕉,3\n');
    });

    it('UTF-8 BOM 文件 Read → Edit 后 BOM 仍在', async () => {
      const file = path.join(tmpDir, 'i.csv');
      await fs.writeFile(file, Buffer.concat([UTF8_BOM, Buffer.from('名称,数量\n苹果,3\n', 'utf-8')]));
      await readOutput(file);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(true);
      const after = await fs.readFile(file);
      expect(after.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
      expect(after.subarray(3).toString('utf-8')).toBe('名称,数量\n香蕉,3\n');
    });

    it('Write 覆盖合法 UTF-8 / BOM 文件照常', async () => {
      for (const bytes of [Buffer.from('名称\n', 'utf-8'), Buffer.concat([UTF8_BOM, Buffer.from('名称\n', 'utf-8')])]) {
        const file = path.join(tmpDir, `w-${bytes.length}.csv`);
        await fs.writeFile(file, bytes);
        await readOutput(file);
        const result = await write(file, '香蕉\n');
        expect(result.ok).toBe(true);
        expect(await fs.readFile(file, 'utf-8')).toBe('香蕉\n');
      }
    });

    it('Append 到合法 UTF-8 / BOM 文件照常', async () => {
      const plain = path.join(tmpDir, 'j.csv');
      await fs.writeFile(plain, '名称\n', 'utf-8');
      expect((await append(plain, '香蕉\n')).ok).toBe(true);
      expect(await fs.readFile(plain, 'utf-8')).toBe('名称\n香蕉\n');

      const bom = path.join(tmpDir, 'j-bom.csv');
      await fs.writeFile(bom, Buffer.concat([UTF8_BOM, Buffer.from('名称\n', 'utf-8')]));
      expect((await append(bom, '香蕉\n')).ok).toBe(true);
      expect((await fs.readFile(bom)).subarray(3).toString('utf-8')).toBe('名称\n香蕉\n');
    });
  });
});
