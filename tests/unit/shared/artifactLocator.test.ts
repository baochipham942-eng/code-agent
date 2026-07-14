import { describe, expect, it } from 'vitest';
import {
  slideIndexFromPartName,
  validateArtifactLocatorV1,
  type ArtifactLocatorV1,
} from '../../../src/shared/contract/artifactLocator';
import {
  buildLocalityFeedbackMessage,
  buildLocatorFeedbackMessage,
  locatorFromLegacyAnchor,
} from '../../../src/shared/livePreview/localityFeedback';

// ADR-040 A1：契约地基的正反例。
//
// 这份测试守的是「locator 敢不敢被信任」：validator 是 host 侧唯一的安全边界
// （web 的 envelope.context 是 passthrough 直接 cast 的，renderer 说什么都不算数），
// 所以每一条 fail-closed 都必须有反例钉住，否则等于没有闸。

const REVISION = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };

function sheetLocator(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    artifact: { kind: 'spreadsheet', filePath: '/tmp/book.xlsx', revision: REVISION },
    target: { kind: 'sheet-range', sheetName: 'Summary', a1: 'B4' },
    display: { label: 'book.xlsx' },
    ...overrides,
  };
}

function pptLocator(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    artifact: { kind: 'presentation', filePath: '/tmp/deck.pptx', revision: REVISION },
    target: {
      kind: 'ppt-slide',
      displayIndex: 1,
      relationshipId: 'rId9',
      slidePartName: 'ppt/slides/slide7.xml',
      textFingerprint: 'fp-abc',
    },
    display: { label: 'deck.pptx' },
    ...overrides,
  };
}

function docxLocator(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    artifact: { kind: 'document', filePath: '/tmp/report.docx', revision: REVISION },
    target: {
      kind: 'docx-paragraph',
      partName: 'word/document.xml',
      paragraphIndex: 12,
      textFingerprint: 'fp-xyz',
    },
    display: { label: 'report.docx' },
    ...overrides,
  };
}

describe('validateArtifactLocatorV1：三种 kind 的正例', () => {
  it.each([
    ['spreadsheet', sheetLocator()],
    ['presentation', pptLocator()],
    ['document', docxLocator()],
  ])('%s locator 通过校验并原样返回', (_kind, input) => {
    const result = validateArtifactLocatorV1(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.locator).toEqual(input);
  });
});

describe('validateArtifactLocatorV1：非法 path 一律 fail-closed', () => {
  it.each([
    ['http URL', 'http://example.com/book.xlsx'],
    ['https URL', 'https://example.com/book.xlsx'],
    ['file scheme', 'file:///tmp/book.xlsx'],
    ['相对路径', 'book.xlsx'],
    ['家目录相对', '~/book.xlsx'],
    ['空串', ''],
    // 以 / 开头、又没有 scheme——「是 URL 吗」和「是绝对路径吗」两道各自都会放行它。
    ['protocol-relative URL', '//evil.com/book.xlsx'],
  ])('%s 不得进入可编辑 locator', (_case, filePath) => {
    const result = validateArtifactLocatorV1(
      sheetLocator({ artifact: { kind: 'spreadsheet', filePath, revision: REVISION } }),
    );
    expect(result.ok).toBe(false);
  });

  it('正常的本地绝对路径通过', () => {
    const result = validateArtifactLocatorV1(
      sheetLocator({
        artifact: { kind: 'spreadsheet', filePath: '/tmp/工作簿 2026.xlsx', revision: REVISION },
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateArtifactLocatorV1：非法 revision 一律 fail-closed', () => {
  it.each([
    ['缺 revision', undefined],
    ['算法不是 sha256', { algorithm: 'md5', value: 'a'.repeat(32) }],
    ['长度不足', { algorithm: 'sha256', value: 'abc' }],
    ['非十六进制', { algorithm: 'sha256', value: 'z'.repeat(64) }],
  ])('%s 被拒', (_case, revision) => {
    const result = validateArtifactLocatorV1(
      sheetLocator({ artifact: { kind: 'spreadsheet', filePath: '/tmp/book.xlsx', revision } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateArtifactLocatorV1：非法 target 一律 fail-closed', () => {
  it('artifact.kind 与 target.kind 错配被拒', () => {
    // 表格产物配 PPT 坐标——真发生时就是拿页码去改单元格
    const result = validateArtifactLocatorV1(
      sheetLocator({ target: (pptLocator() as { target: unknown }).target }),
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ['缺 sheetName', { kind: 'sheet-range', a1: 'B4' }],
    ['sheetName 为空串', { kind: 'sheet-range', sheetName: '', a1: 'B4' }],
    ['a1 不是引用', { kind: 'sheet-range', sheetName: 'S', a1: '第4行' }],
    ['a1 行号为 0', { kind: 'sheet-range', sheetName: 'S', a1: 'B0' }],
  ])('sheet-range %s 被拒', (_case, target) => {
    expect(validateArtifactLocatorV1(sheetLocator({ target })).ok).toBe(false);
  });

  it.each([
    ['slidePartName 不是 slide part', 'ppt/slides/notes1.xml'],
    ['slide 序号为 0', 'ppt/slides/slide0.xml'],
    ['裸文件名', 'slide7.xml'],
  ])('ppt-slide %s 被拒', (_case, slidePartName) => {
    const target = { ...(pptLocator() as { target: Record<string, unknown> }).target, slidePartName };
    expect(validateArtifactLocatorV1(pptLocator({ target })).ok).toBe(false);
  });

  it.each([
    ['partName 不是 document.xml', { partName: 'word/header1.xml' }],
    ['paragraphIndex 为负', { paragraphIndex: -1 }],
    ['paragraphIndex 非整数', { paragraphIndex: 1.5 }],
  ])('docx-paragraph %s 被拒', (_case, patch) => {
    const target = { ...(docxLocator() as { target: Record<string, unknown> }).target, ...patch };
    expect(validateArtifactLocatorV1(docxLocator({ target })).ok).toBe(false);
  });

  it('version 不是 1 被拒', () => {
    expect(validateArtifactLocatorV1(sheetLocator({ version: 2 })).ok).toBe(false);
  });

  it.each([[null], [undefined], ['{}'], [42], [[]]])('非对象输入 %s 被拒', (input) => {
    expect(validateArtifactLocatorV1(input).ok).toBe(false);
  });
});

describe('slideIndexFromPartName：显示页与写入坐标是两个数', () => {
  it('slide7.xml → slide_index 6', () => {
    expect(slideIndexFromPartName('ppt/slides/slide7.xml')).toBe(6);
  });

  it('slide1.xml → slide_index 0', () => {
    expect(slideIndexFromPartName('ppt/slides/slide1.xml')).toBe(0);
  });

  it('非 slide part → null（不猜）', () => {
    expect(slideIndexFromPartName('ppt/slides/slideN.xml')).toBeNull();
  });
});

describe('buildLocatorFeedbackMessage：与 legacy prompt 逐字节一致', () => {
  it('表格 locator 的 prompt 等于 legacy 锚点的 prompt', () => {
    const anchor = {
      kind: 'sheet' as const,
      filePath: '/tmp/book.xlsx',
      cell: 'B4',
      sheetName: 'Summary',
      displayName: 'book.xlsx',
    };
    const locator = locatorFromLegacyAnchor(anchor, REVISION);
    expect(locator).not.toBeNull();

    expect(buildLocatorFeedbackMessage(locator!, '改成 999')).toBe(
      buildLocalityFeedbackMessage(anchor, '改成 999'),
    );
  });

  it('连续 deck 的 PPT locator 的 prompt 等于 legacy 锚点的 prompt', () => {
    // 生成的 PPT：显示第 3 页就是 slide3.xml，两个数恰好相等
    const locator: ArtifactLocatorV1 = {
      version: 1,
      artifact: { kind: 'presentation', filePath: '/tmp/deck.pptx', revision: REVISION },
      target: {
        kind: 'ppt-slide',
        displayIndex: 2,
        relationshipId: 'rId4',
        slidePartName: 'ppt/slides/slide3.xml',
        textFingerprint: 'fp',
      },
      display: { label: 'deck.pptx' },
    };

    expect(buildLocatorFeedbackMessage(locator, '换个标题')).toBe(
      buildLocalityFeedbackMessage(
        { kind: 'ppt', filePath: '/tmp/deck.pptx', slideIndex: 2, displayName: 'deck.pptx' },
        '换个标题',
      ),
    );
  });

  it('乱序 deck：prompt 里显示页是 2，但 slide_index 是 6', () => {
    // 用户看到的第 2 页指向 slide7.xml。legacy 锚点只有一个数，表达不了这件事——
    // 它给出的 slide_index 会是 1，直接改错页。
    const prompt = buildLocatorFeedbackMessage(
      validateArtifactLocatorV1(pptLocator()).ok
        ? (pptLocator() as ArtifactLocatorV1)
        : (null as never),
      '换个标题',
    );

    expect(prompt).toContain('第 2 页');
    expect(prompt).toContain('slide_index=6');
    expect(prompt).toContain('slide_index 用 6');
    expect(prompt).not.toContain('slide_index=1');
  });

  it('Word 段落 locator 的 prompt 在 P0 是禁用的（机制，不是约定）', () => {
    expect(() => buildLocatorFeedbackMessage(docxLocator() as ArtifactLocatorV1, '改这段')).toThrow(
      /B2/,
    );
  });
});

describe('locatorFromLegacyAnchor：P0 拿不到诚实 V1 的一律退回 legacy', () => {
  it('表格锚点带 sheetName → 升级为 V1 且通过校验', () => {
    const locator = locatorFromLegacyAnchor(
      { kind: 'sheet', filePath: '/tmp/book.xlsx', cell: 'B4', sheetName: 'Summary' },
      REVISION,
    );
    expect(locator).not.toBeNull();
    expect(validateArtifactLocatorV1(locator).ok).toBe(true);
    expect(locator!.target).toEqual({ kind: 'sheet-range', sheetName: 'Summary', a1: 'B4' });
  });

  it('表格锚点缺 sheetName → null（不猜表名）', () => {
    expect(
      locatorFromLegacyAnchor({ kind: 'sheet', filePath: '/tmp/book.xlsx', cell: 'B4' }, REVISION),
    ).toBeNull();
  });

  it('PPT 锚点 → null（relationshipId/指纹要等 C1 的 resolver，不编造）', () => {
    expect(
      locatorFromLegacyAnchor(
        { kind: 'ppt', filePath: '/tmp/deck.pptx', slideIndex: 2 },
        REVISION,
      ),
    ).toBeNull();
  });
});
