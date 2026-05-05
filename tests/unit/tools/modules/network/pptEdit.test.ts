// ============================================================================
// ppt_edit (native ToolModule) Tests — P1 Wave 4 D2a
//
// 用 fs.mkdtempSync + 真实 jszip 构造最小 PPTX skeleton 跑 zip 编辑路径。
// 行为保真断言：legacy 中文文案 / emoji / Snapshot id 字符串。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { pptEditModule, executePptEdit } from '../../../../../src/main/tools/modules/network/pptEdit';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSZip = require('jszip') as new () => {
  file(name: string, data: string | Buffer): void;
  generateAsync(opts: { type: 'nodebuffer' }): Promise<Buffer>;
};

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await pptEditModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

let tmpDir: string;
let pptxPath: string;

const SLIDE_XML = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="urn:p" xmlns:a="urn:a">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const PRES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="urn:p" xmlns:r="urn:r">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
    <p:sldId id="258" r:id="rId4"/>
  </p:sldIdLst>
</p:presentation>`;

async function buildMinimalPptx(filePath: string, slides = 3) {
  const zip = new JSZip();
  for (let i = 0; i < slides; i++) {
    zip.file(`ppt/slides/slide${i + 1}.xml`, SLIDE_XML(`原标题${i + 1}`, `原正文${i + 1}`));
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0"?><Relationships/>`,
    );
  }
  zip.file('ppt/presentation.xml', PRES_XML);
  zip.file('ppt/theme/theme1.xml', '<a:theme><a:srgbClr val="FF0000"/></a:theme>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(filePath, buf);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-edit-test-'));
  pptxPath = path.join(tmpDir, 'test.pptx');
  await buildMinimalPptx(pptxPath, 3);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pptEditModule (native)', () => {
  describe('schema', () => {
    it('exposes correct metadata', () => {
      expect(pptEditModule.schema.name).toBe('ppt_edit');
      expect(pptEditModule.schema.category).toBe('network');
      expect(pptEditModule.schema.permissionLevel).toBe('write');
      expect(pptEditModule.schema.readOnly).toBe(false);
      expect(pptEditModule.schema.allowInPlanMode).toBe(false);
      expect(pptEditModule.schema.inputSchema.required).toEqual(['file_path', 'action']);
    });

    it('declares all 9 actions in enum', () => {
      const props = pptEditModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.action?.enum).toEqual([
        'replace_title',
        'replace_content',
        'replace_slide',
        'delete_slide',
        'insert_slide',
        'extract_style',
        'reorder_slides',
        'update_notes',
        'analyze',
      ]);
    });
  });

  describe('五链 + arg validation', () => {
    it('canUseTool deny → PERMISSION_DENIED', async () => {
      const result = await run({ file_path: pptxPath, action: 'analyze' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('aborted signal → ABORTED', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run(
        { file_path: pptxPath, action: 'analyze' },
        makeCtx({ abortSignal: ctrl.signal }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('missing file_path → INVALID_ARGS', async () => {
      const result = await run({ action: 'analyze' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('invalid action → INVALID_ARGS', async () => {
      const result = await run({ file_path: pptxPath, action: 'bogus' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('non-existent file_path → 文件不存在', async () => {
      const result = await run({ file_path: '/nonexistent/x.pptx', action: 'analyze' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/文件不存在/);
    });
  });

  describe('analyze (read-only)', () => {
    it('reports slide count, masters, layouts, fonts, theme colors', async () => {
      const result = await run({ file_path: pptxPath, action: 'analyze' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/📊 PPTX 分析结果/);
        expect(result.output).toMatch(/📄 幻灯片: 3 页/);
        expect(result.meta?.slideCount).toBe(3);
        expect(Array.isArray(result.meta?.slides)).toBe(true);
      }
    });
  });

  describe('replace_title (write + snapshot)', () => {
    it('replaces title and writes snapshot id in output', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'replace_title',
        slide_index: 0,
        title: '新标题',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/已替换第 1 页标题为: "新标题"/);
        expect(result.output).toMatch(/Snapshot: /);
        expect(result.meta?.snapshotId).toBeDefined();
      }
    });

    it('rejects without slide_index', async () => {
      const result = await run({ file_path: pptxPath, action: 'replace_title', title: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects out-of-range slide_index', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'replace_title',
        slide_index: 99,
        title: 'x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/不存在/);
    });
  });

  describe('replace_content (write + snapshot)', () => {
    it('joins points by newline and applies', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'replace_content',
        slide_index: 1,
        points: ['一', '二', '三'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/已替换第 2 页内容/);
      }
    });
  });

  describe('delete_slide (write + snapshot)', () => {
    it('removes slide and updates presentation.xml', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'delete_slide',
        slide_index: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/已删除第 2 页/);
      }
    });
  });

  describe('reorder_slides (write + snapshot)', () => {
    it('rejects when order length != slide count', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'reorder_slides',
        order: [1, 0],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/必须等于幻灯片数/);
      }
    });

    it('accepts valid order', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'reorder_slides',
        order: [2, 0, 1],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/已调整幻灯片顺序: \[2,0,1\]/);
      }
    });

    it('rejects empty order', async () => {
      const result = await run({
        file_path: pptxPath,
        action: 'reorder_slides',
        order: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('insert_slide (legacy hint)', () => {
    it('returns hint without modifying file', async () => {
      const result = await run({ file_path: pptxPath, action: 'insert_slide' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/frontend-slides/);
      }
    });
  });

  describe('progress events', () => {
    it('emits starting + completing', async () => {
      const stages: string[] = [];
      const result = await run(
        { file_path: pptxPath, action: 'analyze' },
        makeCtx(),
        allowAll,
        (e) => stages.push(e.stage),
      );
      expect(result.ok).toBe(true);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });

  describe('export shape', () => {
    it('exports module + executePptEdit', async () => {
      expect(typeof pptEditModule.createHandler).toBe('function');
      const handler = await pptEditModule.createHandler();
      expect(handler.schema).toBe(pptEditModule.schema);
      expect(typeof executePptEdit).toBe('function');
    });
  });
});
