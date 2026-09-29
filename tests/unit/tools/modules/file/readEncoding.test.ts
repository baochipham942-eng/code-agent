// ============================================================================
// N-READ-ENCODING — Read 识别 GBK/GB18030；Edit/Write/Append 对非 UTF-8 已存在文件拒写（方案 B）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';

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

  async function read(file: string) {
    return (await readModule.createHandler()).execute({ file_path: file }, ctx, allowAll);
  }
  async function edit(file: string, oldText: string, newText: string) {
    return (await editModule.createHandler()).execute(
      { file_path: file, edits: [{ old_text: oldText, new_text: newText }] },
      ctx,
      allowAll,
    );
  }

  describe('Read 四态', () => {
    it('UTF-8：原样读出，无编码标注', async () => {
      const file = path.join(tmpDir, 'a.csv');
      await fs.writeFile(file, '名称,数量\n苹果,3\n', 'utf-8');
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('苹果,3');
      expect(result.output).not.toContain('GB18030');
    });

    it('UTF-8 BOM：读出中文，无编码标注', async () => {
      const file = path.join(tmpDir, 'b.csv');
      await fs.writeFile(file, Buffer.concat([UTF8_BOM, Buffer.from('名称,数量\n苹果,3\n', 'utf-8')]));
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('名称,数量');
      expect(result.output).not.toContain('GB18030');
    });

    it('GBK：解出正确中文并向模型标注编码', async () => {
      const file = path.join(tmpDir, 'c.csv');
      await fs.writeFile(file, GBK_BYTES);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('名称,数量');
      expect(result.output).toContain('苹果,3');
      expect(result.output).not.toContain('�');
      expect(result.output).toContain('GB18030');
    });

    it('非法字节：报错而不是 U+FFFD 乱码', async () => {
      const file = path.join(tmpDir, 'd.txt');
      // 0x81 后接 0x20 既不是合法 UTF-8 也不是合法 GB18030
      await fs.writeFile(file, Buffer.from([0x61, 0x81, 0x20, 0x62]));
      const result = await read(file);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('encoding');
    });
  });

  describe('往返：非 UTF-8 文件拒写（方案 B），文件字节不变', () => {
    async function readFirst(file: string) {
      const result = await read(file);
      expect(result.ok).toBe(true);
    }

    it('Edit 拒绝 GBK 文件', async () => {
      const file = path.join(tmpDir, 'e.csv');
      await fs.writeFile(file, GBK_BYTES);
      await readFirst(file);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('GBK');
      expect(result.error).toContain('UTF-8');
      expect(Buffer.compare(await fs.readFile(file), GBK_BYTES)).toBe(0);
    });

    it('Write 覆盖 GBK 文件被拒', async () => {
      const file = path.join(tmpDir, 'f.csv');
      await fs.writeFile(file, GBK_BYTES);
      await readFirst(file);
      const result = await (await writeModule.createHandler()).execute(
        { file_path: file, content: '名称,数量\n香蕉,3\n' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('GBK');
      expect(Buffer.compare(await fs.readFile(file), GBK_BYTES)).toBe(0);
    });

    it('Append 追加到 GBK 文件被拒', async () => {
      const file = path.join(tmpDir, 'g.csv');
      await fs.writeFile(file, GBK_BYTES);
      const result = await (await appendModule.createHandler()).execute(
        { file_path: file, content: '香蕉,4\n' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('GBK');
      expect(Buffer.compare(await fs.readFile(file), GBK_BYTES)).toBe(0);
    });

    it('新建文件照旧 UTF-8', async () => {
      const file = path.join(tmpDir, 'new.csv');
      const result = await (await writeModule.createHandler()).execute(
        { file_path: file, content: '名称\n香蕉\n' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('名称\n香蕉\n');
    });
  });

  describe('偶有坏字节的 UTF-8（不能被整段重解成 GBK 乱码）', () => {
    const head = Buffer.from('名称,数量\n苹果,3', 'utf-8');
    const tail = Buffer.from('\n', 'utf-8');
    const cases: Array<[string, Buffer]> = [
      ['单个 0x80', Buffer.concat([head, Buffer.from([0x80]), tail])],
      ['0x92 + 字母', Buffer.concat([head, Buffer.from([0x92, 0x61]), tail])],
    ];

    for (const [label, bytes] of cases) {
      it(`Read：${label}，中文原样可见、不出现 GBK 乱码，并告知无法解码的字节数`, async () => {
        const file = path.join(tmpDir, 'lossy.csv');
        await fs.writeFile(file, bytes);
        const result = await read(file);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.output).toContain('名称,数量');
        expect(result.output).toContain('苹果,3');
        expect(result.output).not.toContain('鍚嶇О');
        expect(result.output).not.toContain('鑻规灉');
        expect(result.output).not.toContain('GB18030');
        expect(result.output).toMatch(/1 (byte|invalid)/i);
      });

      it(`Edit：${label}，拒写（回写会把坏字节变成 EF BF BD），文件字节不变`, async () => {
        const file = path.join(tmpDir, 'lossy-edit.csv');
        await fs.writeFile(file, bytes);
        expect((await read(file)).ok).toBe(true);
        const result = await edit(file, '苹果', '香蕉');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/not valid UTF-8|invalid/i);
        expect(result.error).not.toContain('GBK');
        expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
      });

      it(`Append：${label}，允许且不改动已有字节`, async () => {
        const file = path.join(tmpDir, 'lossy-append.csv');
        await fs.writeFile(file, bytes);
        const result = await (await appendModule.createHandler()).execute(
          { file_path: file, content: '香蕉,4\n' },
          ctx,
          allowAll,
        );
        expect(result.ok).toBe(true);
        const after = await fs.readFile(file);
        expect(after.subarray(0, bytes.length).equals(bytes)).toBe(true);
        expect(after.subarray(bytes.length).toString('utf-8')).toBe('香蕉,4\n');
      });
    }

    // ASCII 主体（源码 / 日志）里的孤立坏字节：非 ASCII 有效字符为 0，占比判据帮不上，靠「高字节稀疏 + 不是纯 GB2312 双字节」
    const asciiCases: Array<[string, Buffer, string[]]> = [
      ['源码里 don 0x92 t', Buffer.concat([Buffer.from('function don'), Buffer.from([0x92]), Buffer.from("t() { return 1; }\n")]), ['function don', 't() { return 1; }']],
      ['日志里单个 0x80', Buffer.concat([Buffer.from('hello '), Buffer.from([0x80]), Buffer.from(' world\n')]), ['hello ', ' world']],
      ['ASCII 夹 0x81 0x20（连 GB18030 都不合法）', Buffer.concat([Buffer.from('a = 1; '), Buffer.from([0x81, 0x20]), Buffer.from('b = 2;\n')]), ['a = 1; ', 'b = 2;']],
    ];
    for (const [label, bytes, mustContain] of asciiCases) {
      it(`ASCII 主体 ${label}：Read 保留两侧 ASCII、不出现 GBK 提示，Edit 拒写、Append 放行`, async () => {
        const file = path.join(tmpDir, 'ascii-lossy.txt');
        await fs.writeFile(file, bytes);
        const result = await read(file);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        for (const piece of mustContain) expect(result.output).toContain(piece);
        expect(result.output).not.toContain('GB18030');
        expect(result.output).toMatch(/invalid byte sequence/i);
        const editResult = await edit(file, mustContain[0], 'X');
        expect(editResult.ok).toBe(false);
        if (editResult.ok) return;
        expect(editResult.error).not.toContain('GBK');
        expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
        const appendResult = await (await appendModule.createHandler()).execute(
          { file_path: file, content: 'more\n' },
          ctx,
          allowAll,
        );
        expect(appendResult.ok).toBe(true);
        expect(Buffer.compare((await fs.readFile(file)).subarray(0, bytes.length), bytes)).toBe(0);
      });
    }

    it('短 UTF-8「名称\\n」+ 单个 0x80：Read 中文原样可见、不出现 GBK 乱码，Edit 拒写', async () => {
      const bytes = Buffer.concat([Buffer.from('id=名称;ok'), Buffer.from([0x80])]);
      const file = path.join(tmpDir, 'short-lossy.txt');
      await fs.writeFile(file, bytes);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('id=名称;ok');
      expect(result.output).not.toContain('鍚嶇О');
      expect(result.output).not.toContain('GB18030');
      const editResult = await edit(file, '名称', '名字');
      expect(editResult.ok).toBe(false);
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it('ASCII 正文含 café / 25°C + 坏字节：Read 不出现 caf茅 / 掳 乱码，无 GBK 提示', async () => {
      const bytes = Buffer.concat([
        Buffer.from('The café is open today, please come by before the end of the week; it was 25°C outside.\n', 'utf-8'),
        Buffer.from([0x92]),
      ]);
      const file = path.join(tmpDir, 'latin-lossy.txt');
      await fs.writeFile(file, bytes);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('café');
      expect(result.output).toContain('25°C');
      expect(result.output).not.toContain('caf茅');
      expect(result.output).not.toContain('掳');
      expect(result.output).not.toContain('GB18030');
    });

    it('ASCII 主体的真 GBK（英文多、只夹几个中文词）：仍判 GBK、仍拒写', async () => {
      // 「id,name\n1,名称\n2,苹果\nplain english text to keep high bytes sparse ...」
      const bytes = Buffer.concat([
        Buffer.from('id,name,note\n1,', 'utf-8'),
        Buffer.from('c3fbb3c6', 'hex'),
        Buffer.from(',keep the ascii part long enough so that high bytes are sparse in this file\n2,', 'utf-8'),
        Buffer.from('c6bbb9fb', 'hex'),
        Buffer.from(',another long ascii tail to stay above the sparse threshold for sure\n', 'utf-8'),
      ]);
      const file = path.join(tmpDir, 'sparse-gbk.csv');
      await fs.writeFile(file, bytes);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('1,名称');
      expect(result.output).toContain('GB18030');
      const editResult = await edit(file, 'id,name', 'ID,NAME');
      expect(editResult.ok).toBe(false);
      if (editResult.ok) return;
      expect(editResult.error).toContain('GBK');
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it('真 GBK 样本仍判 GBK、仍拒写（判据没把真 GBK 放过）', async () => {
      const file = path.join(tmpDir, 'still-gbk.csv');
      await fs.writeFile(file, GBK_BYTES);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('GB18030');
      const editResult = await edit(file, '苹果', '香蕉');
      expect(editResult.ok).toBe(false);
      if (editResult.ok) return;
      expect(editResult.error).toContain('GBK');
    });

    it('GBK 文件以「锘」+ BF 开头（字节恰为 EF BB BF）：不能被误当 UTF-8 BOM 剥掉', async () => {
      // 「锘卡」= EF BB | BF A8。误剥 EF BB BF 后剩 A8 0A，两种编码都失败。
      const bytes = Buffer.from('efbbbfa80a', 'hex');
      const file = path.join(tmpDir, 'bom-lookalike.txt');
      await fs.writeFile(file, bytes);
      const result = await read(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('锘卡');
      expect(result.output).toContain('GB18030');
      const appendResult = await (await appendModule.createHandler()).execute(
        { file_path: file, content: '香蕉\n' },
        ctx,
        allowAll,
      );
      expect(appendResult.ok).toBe(false);
      expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });
  });

  describe('UTF-8 往返回归', () => {
    it('UTF-8 文件 Read → Edit 生效，其余字节不变', async () => {
      const file = path.join(tmpDir, 'h.csv');
      await fs.writeFile(file, '名称,数量\n苹果,3\n', 'utf-8');
      expect((await read(file)).ok).toBe(true);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('名称,数量\n香蕉,3\n');
    });

    it('UTF-8 BOM 文件 Read → Edit 后 BOM 仍在', async () => {
      const file = path.join(tmpDir, 'i.csv');
      await fs.writeFile(file, Buffer.concat([UTF8_BOM, Buffer.from('名称,数量\n苹果,3\n', 'utf-8')]));
      expect((await read(file)).ok).toBe(true);
      const result = await edit(file, '苹果', '香蕉');
      expect(result.ok).toBe(true);
      const after = await fs.readFile(file);
      expect(after.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
      expect(after.subarray(3).toString('utf-8')).toBe('名称,数量\n香蕉,3\n');
    });

    it('Append 到 UTF-8 文件照常', async () => {
      const file = path.join(tmpDir, 'j.csv');
      await fs.writeFile(file, '名称\n', 'utf-8');
      const result = await (await appendModule.createHandler()).execute(
        { file_path: file, content: '香蕉\n' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('名称\n香蕉\n');
    });
  });
});
