import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import XLSX from 'xlsx';

// ADR-040 A2：写前 guard 的对账测试。
//
// 形态照搬 sheetLocalityRoundtrip：真 xlsx → 真提取 handler → UI 的 A1 换算 → 真 guard。
// **禁止在测试里手抄换算公式**——被抄的那份要是错的，抄的人不会发现（这正是行错位
// 那个洞活到今天的原因）。所以这里的锚点必须从真提取结果 + sheetCellRef 算出来。
//
// guard 守的是「模型改了坐标 / 文件被外部改过」时不落盘。它挡不住模型不听话地
// 拒绝调用工具——那归付费验收脚本管；坐标本身对不对，归这个免费的确定性测试。

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { sheetCellRef } from '../../../src/shared/livePreview/sheetCoords';
import {
  buildLocalityFeedbackMessage,
  buildLocatorFeedbackMessage,
} from '../../../src/shared/livePreview/localityFeedback';
import {
  findActiveLocator,
  getArtifactLocatorPreflightBlock,
  upgradeLegacyAnchor,
  LOCATOR_BLOCK_CODE,
} from '../../../src/host/tools/artifacts/artifactLocatorHost';
import { resolvePresentationPackageIndex } from '../../../src/host/tools/artifacts/presentationPackageIndex';
import type { Message } from '../../../src/shared/contract';
import type { ArtifactLocatorV1 } from '../../../src/shared/contract/artifactLocator';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
interface SheetPreview { name: string; headers: string[]; rows: unknown[][] }

const SALES_COLUMN = 1;
let handlers: Map<string, RawHandler>;
let workDir: string;

beforeEach(async () => {
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: RawHandler) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  workDir = await mkdtemp(join(tmpdir(), 'locator-guard-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function monthlySheet(march: number): unknown[][] {
  return [['月份', '销售额'], ['一月', march / 3], [], ['三月', march]];
}

async function writeWorkbook(name: string, sheets: Record<string, unknown[][]>): Promise<string> {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  }
  const filePath = join(workDir, name);
  await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

async function writeGeneratedDeck(name: string, slideCount: number): Promise<string> {
  const zip = new JSZip();
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join('');
  const relationships = Array.from(
    { length: slideCount },
    (_, index) => `<Relationship Id="rId${index + 2}" Type="slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join('');
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships>${relationships}</Relationships>`,
  );
  for (let index = 0; index < slideCount; index += 1) {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<p:sld xmlns:p="p" xmlns:a="a"><a:t>Generated slide ${index + 1}</a:t></p:sld>`,
    );
  }
  const filePath = join(workDir, name);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

/** 复刻「用户在预览里点了某一行」：走真提取 + UI 同一个换算函数，绝不手抄 A1。 */
async function clickInPreview(filePath: string, sheetIndex: number, rowText: string) {
  const handler = handlers.get('extract-excel-json');
  if (!handler) throw new Error('extract-excel-json 未注册');
  const { sheets } = (await handler(null, filePath)) as { sheets: SheetPreview[] };
  const sheet = sheets[sheetIndex];
  const dataRowIndex = sheet.rows.findIndex((r) => r?.[0] === rowText);
  expect(dataRowIndex).toBeGreaterThanOrEqual(0);
  return {
    kind: 'sheet' as const,
    filePath,
    cell: sheetCellRef(dataRowIndex, SALES_COLUMN),
    sheetName: sheet.name,
  };
}

function userTurn(locator: ArtifactLocatorV1 | null): Message[] {
  return [
    { id: 'u1', role: 'user', content: '定点反馈', timestamp: 1, ...(locator ? { metadata: { artifactLocator: locator } } : {}) },
  ] as Message[];
}

function ctxOf(messages: Message[]) {
  return { messages, workingDirectory: workDir };
}

function docEditCall(filePath: string, operations: unknown[]) {
  return { name: 'DocEdit', arguments: { file_path: filePath, operations } };
}

describe('upgradeLegacyAnchor：host 补 revision 后才算数', () => {
  it('真表格锚点升级成通过校验的 V1，revision 是文件真实 sha256', async () => {
    const filePath = await writeWorkbook('multi.xlsx', { Sheet1: monthlySheet(300), Summary: monthlySheet(3000) });
    const anchor = await clickInPreview(filePath, 1, '三月');

    const locator = await upgradeLegacyAnchor(anchor);
    expect(locator).not.toBeNull();
    expect(locator!.artifact.filePath).toBe(filePath);
    expect(locator!.artifact.revision.value).toMatch(/^[0-9a-f]{64}$/);
    expect(locator!.target).toEqual({ kind: 'sheet-range', sheetName: 'Summary', a1: 'B4' });
  });

  it('文件不存在 → null（退回 legacy，不是抛错炸掉发送）', async () => {
    expect(
      await upgradeLegacyAnchor({ kind: 'sheet', filePath: join(workDir, 'nope.xlsx'), cell: 'B4', sheetName: 'S' }),
    ).toBeNull();
  });

  it('生成 PPT 的 selectedIndex 经 C1 resolver 升级为 locator，旧 prompt 逐字节不变', async () => {
    const filePath = await writeGeneratedDeck('generated.pptx', 3);
    const anchor = {
      kind: 'ppt' as const,
      filePath,
      slideIndex: 2,
      displayName: 'generated.pptx',
    };

    const locator = await upgradeLegacyAnchor(anchor);
    expect(locator).not.toBeNull();
    expect(locator!.artifact.revision.value).toMatch(/^[0-9a-f]{64}$/);
    expect(locator!.target).toMatchObject({
      kind: 'ppt-slide',
      displayIndex: 2,
      relationshipId: 'rId4',
      slidePartName: 'ppt/slides/slide3.xml',
      textFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(buildLocatorFeedbackMessage(locator!, '换个标题')).toBe(
      buildLocalityFeedbackMessage(anchor, '换个标题'),
    );
  });
});

describe('findActiveLocator：locator 的有效期', () => {
  it('最近一条 user 消息带 locator → 生效', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const locator = await upgradeLegacyAnchor(await clickInPreview(filePath, 0, '三月'));
    expect(findActiveLocator(userTurn(locator))).not.toBeNull();
  });

  it('用户之后又发了一条没带 locator 的消息 → 失效（换话题了）', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const locator = await upgradeLegacyAnchor(await clickInPreview(filePath, 0, '三月'));
    const messages = [
      ...userTurn(locator),
      { id: 'a1', role: 'assistant', content: '好的', timestamp: 2 },
      { id: 'u2', role: 'user', content: '再帮我看看别的', timestamp: 3 },
    ] as Message[];
    expect(findActiveLocator(messages)).toBeNull();
  });

  it('metadata 里塞了个非法 locator → null，不当它存在', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'x', timestamp: 1, metadata: { artifactLocator: { version: 1 } } },
    ] as unknown as Message[];
    expect(findActiveLocator(messages)).toBeNull();
  });
});

describe('写前 guard：模型改了坐标就不落盘', () => {
  it('听话的模型：坐标原样交回 → 放行', async () => {
    const filePath = await writeWorkbook('multi.xlsx', { Sheet1: monthlySheet(300), Summary: monthlySheet(3000) });
    const anchor = await clickInPreview(filePath, 1, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(filePath, [{ action: 'set_cell', sheet: anchor.sheetName, cell: anchor.cell, value: 999 }]),
    );
    expect(block).toBeNull();
  });

  it('模型漏传 sheet → 阻断（excelEdit 会静默落到第一张表）', async () => {
    const filePath = await writeWorkbook('multi.xlsx', { Sheet1: monthlySheet(300), Summary: monthlySheet(3000) });
    const anchor = await clickInPreview(filePath, 1, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(filePath, [{ action: 'set_cell', cell: anchor.cell, value: 999 }]),
    );
    expect(block).not.toBeNull();
    expect(block!.metadata.reason).toBe('sheet_omitted');
    expect(block!.metadata.blocked).toBe(true);
  });

  it('模型换了单元格 → 阻断', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const anchor = await clickInPreview(filePath, 0, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(filePath, [{ action: 'set_cell', sheet: anchor.sheetName, cell: 'B3', value: 999 }]),
    );
    expect(block!.metadata.reason).toBe('cell_mismatch');
  });

  it('模型换了文件 → 阻断', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const other = await writeWorkbook('other.xlsx', { Sheet1: monthlySheet(1) });
    const anchor = await clickInPreview(filePath, 0, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(other, [{ action: 'set_cell', sheet: anchor.sheetName, cell: anchor.cell, value: 999 }]),
    );
    expect(block!.metadata.reason).toBe('file_mismatch');
  });

  it('用户点选后文件被外部改过 → 阻断并提示刷新（revision fail-closed）', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const anchor = await clickInPreview(filePath, 0, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    // 别的程序在用户点选之后改了这个工作簿：行可能已经挪位，旧 B4 不再是用户看到的那格
    await writeWorkbook('a.xlsx', { Sheet1: [['月份', '销售额'], ['新增行', 1], ...monthlySheet(300).slice(1)] });

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(filePath, [{ action: 'set_cell', sheet: anchor.sheetName, cell: anchor.cell, value: 999 }]),
    );
    expect(block!.metadata.reason).toBe('revision_drift');
    expect(block!.error).toContain('刷新');
    // 不变量 5：不把 sha256 / 内部结构名丢给用户
    expect(block!.error).not.toMatch(/[0-9a-f]{64}/);
  });

  it('没有 locator 的普通轮次 → 完全不干预（legacy 行为原样）', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(null)),
      docEditCall(filePath, [{ action: 'set_cell', cell: 'ZZ99', value: 1 }]),
    );
    expect(block).toBeNull();
  });

  it('不在授权面内的工具 → 不干预', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const locator = await upgradeLegacyAnchor(await clickInPreview(filePath, 0, '三月'));
    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      { name: 'Read', arguments: { file_path: '/etc/hosts' } },
    );
    expect(block).toBeNull();
  });

  it('阻断结果带 skipped 标记，metadata 不含文档正文', async () => {
    const filePath = await writeWorkbook('a.xlsx', { Sheet1: monthlySheet(300) });
    const anchor = await clickInPreview(filePath, 0, '三月');
    const locator = await upgradeLegacyAnchor(anchor);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      docEditCall(filePath, [{ action: 'set_cell', sheet: anchor.sheetName, cell: 'A1', value: 999 }]),
    );
    expect(block!.code).toBe(LOCATOR_BLOCK_CODE);
    expect(block!.metadata.skipped).toBe(true);
    expect(JSON.stringify(block!.metadata)).not.toContain('三月');
  });
});

describe('写前 guard：PPT 页坐标（locator 由 C1/C3 生产，guard 先总起来）', () => {
  const pptLocator = (slidePartName: string, displayIndex: number): ArtifactLocatorV1 => ({
    version: 1,
    artifact: { kind: 'presentation', filePath: '/tmp/deck.pptx', revision: { algorithm: 'sha256', value: 'a'.repeat(64) } },
    target: { kind: 'ppt-slide', displayIndex, relationshipId: 'rId9', slidePartName, textFingerprint: 'fp' },
    display: { label: 'deck.pptx' },
  });

  it('乱序 deck：用户看到第 2 页指向 slide7.xml，模型交 slide_index=1 → 阻断', async () => {
    // 这条是 ADR-040 PPT 决策的核心：显示顺序绝不能推导执行坐标。
    const filePath = join(workDir, 'deck.pptx');
    await writeFile(filePath, 'not-a-real-pptx');
    const locator = { ...pptLocator('ppt/slides/slide7.xml', 1) };
    locator.artifact.filePath = filePath;
    const { computeArtifactRevision } = await import('../../../src/host/tools/artifacts/artifactLocatorHost');
    locator.artifact.revision = await computeArtifactRevision(filePath);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      { name: 'ppt_edit', arguments: { file_path: filePath, action: 'replace_title', slide_index: 1, title: 'x' } },
    );
    expect(block!.metadata.reason).toBe('slide_mismatch');
    expect(block!.metadata.expected).toBe(6);
  });

  it('模型交了 resolver 算出的 slide_index=6 → 放行', async () => {
    const filePath = join(workDir, 'deck.pptx');
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>第一页</a:t></p:sld>');
    zip.file('ppt/slides/slide7.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>第二页</a:t></p:sld>');
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst>'
        + '<p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId9"/>'
        + '</p:sldIdLst></p:presentation>',
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId2" Target="slides/slide2.xml"/>'
        + '<Relationship Id="rId9" Target="slides/slide7.xml"/></Relationships>',
    );
    await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const target = (await resolvePresentationPackageIndex(filePath))[1];
    const locator = { ...pptLocator(target.slidePartName, target.displayIndex), target: { kind: 'ppt-slide' as const, ...target } };
    locator.artifact.filePath = filePath;
    const { computeArtifactRevision } = await import('../../../src/host/tools/artifacts/artifactLocatorHost');
    locator.artifact.revision = await computeArtifactRevision(filePath);

    const block = await getArtifactLocatorPreflightBlock(
      ctxOf(userTurn(locator)),
      { name: 'ppt_edit', arguments: { file_path: filePath, action: 'replace_title', slide_index: 6, title: 'x' } },
    );
    expect(block).toBeNull();
  });
});
