// ============================================================================
// N-READ-ENCODING — Read 默认 UTF-8 + 坏字节告知 + encoding 参数；Edit/Write/Append 对非法 UTF-8 已存在文件拒写（不猜编码）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
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
import { existingPathWriteRefusal } from '../../../../../src/host/tools/utils/textEncodingGuard';

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

    it("encoding:'gbk' 读 BOM+GBK：先剥误加的 BOM，得原文、不含「锘」也不吞字", async () => {
      const sample = path.join(tmpDir, 'bom-gbk.csv');
      await fs.writeFile(sample, Buffer.concat([UTF8_BOM, GBK_BYTES]));
      const sampleOut = await readOutput(sample, { encoding: 'gbk' });
      expect(sampleOut).toContain('名称,数量');
      expect(sampleOut).toContain('苹果,3');
      const short = path.join(tmpDir, 'bom-gbk2.txt');
      await fs.writeFile(short, Buffer.concat([UTF8_BOM, Buffer.from('GBK'), Buffer.from('cec4bcfe0a', 'hex')]));
      const shortOut = await readOutput(short, { encoding: 'gbk' });
      expect(shortOut).toContain('GBK文件');
      expect(shortOut).not.toContain('锘');
    });

    it("encoding:'gbk' 遇非法 GB18030 字节：明确报错", async () => {
      const file = path.join(tmpDir, 'bad-gbk.txt');
      await fs.writeFile(file, Buffer.from([0x61, 0x81, 0x20, 0x62]));
      const result = await read(file, { encoding: 'gbk' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('GBK');
    });

    it("encoding:'gbk' 多页读：首页续读尾标同时给 offset 与 encoding: 'gbk'", async () => {
      const file = path.join(tmpDir, 'paged-gbk.csv');
      await fs.writeFile(file, Buffer.concat([GBK_BYTES, GBK_BYTES, GBK_BYTES]));
      const output = await readOutput(file, { encoding: 'gbk', limit: 2 });
      expect(output).toContain("Continue with Read offset=3, encoding: 'gbk' and an explicit limit.");
      expect(output.trimEnd().endsWith('... (5 more lines)')).toBe(true);
    });

    it('UTF-8 多页读：续读尾标不含 encoding，文案与改动前逐字一致', async () => {
      const file = path.join(tmpDir, 'paged-utf8.csv');
      await fs.writeFile(file, '名称,数量\n苹果,3\n'.repeat(3), 'utf-8');
      const output = await readOutput(file, { limit: 2 });
      expect(output).toContain(
        '\n\n[Read incomplete] Showed lines 1-2 (2 lines). 5 lines remain unread and were not returned. ' +
          'Continue with Read offset=3 and an explicit limit. ' +
          'Do not treat this result as the whole file.\n' +
          '... (5 more lines)',
      );
      expect(output).not.toContain("encoding: 'gbk'");
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

    it.skipIf(process.platform === 'win32')('FIFO / 非普通文件不做整读检查（readFile 等不到 EOF 会挂住）', async () => {
      const fifo = path.join(tmpDir, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const outcome = await Promise.race([
        existingPathWriteRefusal(fifo),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung: guard read a FIFO'), 1000)),
      ]);
      expect(outcome).toBeNull();
    });

    it('超过体积上限的普通文件跳过检查（不整读进内存）；不存在的路径视为新建', async () => {
      const big = path.join(tmpDir, 'big.log');
      await fs.writeFile(big, Buffer.from([0x80, 0x81]));
      await fs.truncate(big, 33 * 1024 * 1024);
      expect(await existingPathWriteRefusal(big)).toBeNull();
      expect(await existingPathWriteRefusal(path.join(tmpDir, 'nope.txt'))).toBeNull();
    });

    it('非 UTF-8 的 SKILL.md：Write/Append 先给出编码拒写，而不是被有损比较误报官方段落保护', async () => {
      const file = path.join(tmpDir, 'SKILL.md');
      const bytes = Buffer.concat([
        Buffer.from('<!-- NEO:OFFICIAL-SKILL:BEGIN -->\n'),
        Buffer.from('c3fbb3c62ccafdc1bf0a', 'hex'),
        Buffer.from('<!-- NEO:OFFICIAL-SKILL:END -->\n'),
      ]);
      await fs.writeFile(file, bytes);
      await readOutput(file);
      const written = await write(file, '# rewritten without the official section\n');
      expect(written.ok).toBe(false);
      if (!written.ok) expect(written.error).toContain('not valid UTF-8');
      const appended = await append(file, '\nnotes\n');
      expect(appended.ok).toBe(false);
      if (!appended.ok) expect(appended.error).toContain('not valid UTF-8');
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
