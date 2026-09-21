// ============================================================================
// read_xlsx 命名空间前缀 rels 回归测试（#1995）
//
// 部分 xlsx 生成器把 `.rels` 部件写成 `<ns1:Relationships ...>`，ExcelJS 4.4.0
// 按节点全名匹配直接抛 `Unexpected xml node in parseOpen: {"name":"ns1:Relationships",...}`
// （夜跑 2026-09-20：42 次 / 32 会话，gdp-76418a2c、gdp-4c18ebae 反复重读打转）。
// 本文件不 mock exceljs——用真实 ExcelJS + 真实临时文件端到端钉住修复。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { executeReadXlsx } from '../../../../../src/host/tools/modules/network/readXlsx';
import {
  isNsPrefixedRelationshipsError,
  stripRelationshipsNsPrefix,
  normalizeXlsxRelationshipsNamespaces,
} from '../../../../../src/host/tools/modules/network/xlsxRelsNsNormalize';

const RELS_NS_URI = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 最小 xlsx：rels 部件可选带 ns1 前缀，内容两行（表头 + 一行数据）。 */
async function buildXlsxFixture(opts: { prefixedRels: boolean }): Promise<Buffer> {
  const rels = (inner: string) =>
    opts.prefixedRels
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<ns1:Relationships xmlns:ns1="${RELS_NS_URI}">${inner
          .replace(/<Relationship /g, '<ns1:Relationship ')
          .replace(/<\/Relationship>/g, '</ns1:Relationship>')}</ns1:Relationships>`
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="${RELS_NS_URI}">${inner}</Relationships>`;

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    rels(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    ),
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
    ),
  );
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>Name</t></si><si><t>Age</t></si><si><t>Alice</t></si>
</sst>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>
</sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('read_xlsx ns-prefixed rels (#1995)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'readxlsx-nsrels-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('end-to-end: ns1:Relationships 的 xlsx 读出内容，不再 FS_ERROR', async () => {
    const filePath = path.join(tmpDir, 'ns1-rels.xlsx');
    await fs.promises.writeFile(filePath, await buildXlsxFixture({ prefixedRels: true }));

    const result = await executeReadXlsx({ file_path: filePath }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('| Name | Age |');
      expect(result.output).toContain('| Alice | 30 |');
      expect(result.output).toContain('工作表: Sheet1');
    }
  });

  it('对照组：无前缀的同一夹具本就能读（确认夹具本身合法）', async () => {
    const filePath = path.join(tmpDir, 'plain-rels.xlsx');
    await fs.promises.writeFile(filePath, await buildXlsxFixture({ prefixedRels: false }));

    const result = await executeReadXlsx({ file_path: filePath }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('| Alice | 30 |');
    }
  });

  it('isNsPrefixedRelationshipsError 只命中带前缀 Relationships 的 parseOpen 错误', () => {
    const prodError = new Error(
      'Unexpected xml node in parseOpen: {"name":"ns1:Relationships","attributes":{"xmlns:ns1":"http://schemas.openxmlformats.org/package/2006/relationships"}}',
    );
    expect(isNsPrefixedRelationshipsError(prodError)).toBe(true);
    expect(isNsPrefixedRelationshipsError('Unexpected xml node in parseOpen: {"name":"ns2:Relationships"}')).toBe(true);
    expect(isNsPrefixedRelationshipsError(new Error('Unexpected xml node in parseOpen: {"name":"Foo"}'))).toBe(false);
    expect(isNsPrefixedRelationshipsError(new Error('anchors undefined'))).toBe(false);
  });

  it('stripRelationshipsNsPrefix 剥前缀并换成默认命名空间，无前缀时原样返回', () => {
    const prefixed =
      `<ns1:Relationships xmlns:ns1="${RELS_NS_URI}">` +
      '<ns1:Relationship Id="rId1" Type="t" Target="xl/workbook.xml"/>' +
      '</ns1:Relationships>';
    const stripped = stripRelationshipsNsPrefix(prefixed);
    expect(stripped).toBe(
      `<Relationships xmlns="${RELS_NS_URI}">` +
        '<Relationship Id="rId1" Type="t" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    );

    const plain = `<Relationships xmlns="${RELS_NS_URI}"></Relationships>`;
    expect(stripRelationshipsNsPrefix(plain)).toBe(plain);
  });

  it('normalizeXlsxRelationshipsNamespaces 重写 zip 内所有 .rels 部件', async () => {
    const filePath = path.join(tmpDir, 'to-normalize.xlsx');
    await fs.promises.writeFile(filePath, await buildXlsxFixture({ prefixedRels: true }));

    const normalized = await normalizeXlsxRelationshipsNamespaces(filePath);
    const zip = await JSZip.loadAsync(normalized);
    const relsNames = Object.keys(zip.files).filter((n) => n.endsWith('.rels'));
    expect(relsNames.length).toBeGreaterThan(0);
    for (const name of relsNames) {
      const xml = await zip.file(name)!.async('string');
      expect(xml).not.toContain('ns1:');
      expect(xml).toContain('<Relationships');
    }
  });
});
