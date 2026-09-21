// ============================================================================
// pdf_generate 真实生成路径 smoke（不 mock pdfkit / fs）
//
// 回归 issue #1996：academic 主题用 fontFamily+'-Bold' 拼出 'Times-Roman-Bold'
// （不存在的标准字体名），pdfkit 把它当文件路径走 fs.readFileSync；esbuild
// bundle 里 pdfkit 走 standalone 构建、内部 fs 是 browserify 空垫片，报
// "m.readFileSync is not a function"（未打包时则是 ENOENT）。本测试用真实
// pdfkit 跑全 3 主题 + 标题/正文/列表/引用/代码全 block 类型，任何非法字体
// 名都会在这里被真实渲染路径当场打出来。
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pdfGenerateModule } from '../../../../../src/host/tools/modules/network/pdfGenerate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-real-pdf',
    workingDir,
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

// 覆盖所有 block 类型：title(#)、heading(##)、subheading(###)、paragraph、
// unordered/ordered list、code、quote——quote 走 obliqueFont、其余标题行走 boldFont
const FULL_MARKDOWN = [
  '# 一级标题',
  '## 二级标题',
  '### 三级标题',
  '正文段落 with english words mixed in.',
  '- 无序列表项',
  '1. 有序列表项',
  '> 引用块文字',
  '```',
  'const x = 1;',
  '```',
].join('\n');

describe('pdfGenerate 真实生成路径（无 mock）', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['default', 'academic', 'minimal'] as const)(
    'theme=%s 真实生成出合法 PDF 文件',
    async (theme) => {
      const workingDir = await mkdtemp(join(tmpdir(), 'pdf-generate-real-'));
      tmpDirs.push(workingDir);

      const handler = await pdfGenerateModule.createHandler();
      const result = await handler.execute(
        { title: `${theme} 主题测试`, content: FULL_MARKDOWN, theme },
        makeCtx(workingDir),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const meta = result.meta as { filePath: string; fileSize: number };
      const bytes = await readFile(meta.filePath);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(meta.fileSize).toBe(bytes.length);
      expect(meta.fileSize).toBeGreaterThan(0);
    },
  );
});
