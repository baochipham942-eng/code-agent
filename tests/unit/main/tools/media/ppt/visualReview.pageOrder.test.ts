// ============================================================================
// pdfToImages 页序回归 — ImageMagick %d 不补零导致字符串定序错页
// ============================================================================
// 文件名取自 2026-07-14 本机实测（ImageMagick 7.1.2-27 + Ghostscript 10.06.0），
// 13 页 PDF 跑代码里那条真实命令：
//   magick -density 150 -quality 85 deck.pdf out/deck-%d.jpg
// 真实产出 deck-0.jpg..deck-12.jpg（不补零、0-based）；旧的 .sort() 字符串定序
// 把它排成 0,1,10,11,12,2,... → VLM 拿到的页序是 1,2,11,12,13,3,...
// ============================================================================

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());
const resolveHelperBinaryMock = vi.hoisted(() => vi.fn());
const resolvePresentationPackageIndexMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ execSync: execSyncMock }));
vi.mock('../../../../../../src/host/runtime/runtimeAssetResolver', () => ({
  resolveHelperBinary: resolveHelperBinaryMock,
}));
vi.mock('../../../../../../src/host/tools/artifacts/presentationPackageIndex', () => ({
  resolvePresentationPackageIndex: resolvePresentationPackageIndexMock,
}));

import {
  collectPageImages,
  convertToScreenshots,
  reviewPresentation,
} from '../../../../../../src/host/tools/media/ppt/visualReview';

const dirs: string[] = [];
const originalLibreOfficePath = process.env.LIBREOFFICE_PATH;

function makeDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'visual-review-page-order-'));
  dirs.push(dir);
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}

beforeEach(() => {
  execSyncMock.mockReset();
  resolveHelperBinaryMock.mockReset();
  resolvePresentationPackageIndexMock.mockReset();
});

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (originalLibreOfficePath === undefined) delete process.env.LIBREOFFICE_PATH;
  else process.env.LIBREOFFICE_PATH = originalLibreOfficePath;
});

interface ConversionFixture {
  root: string;
  pptxPath: string;
  screenshotDir: string;
  pdftoppmPath: string;
}

function makeConversionFixture(baseName = 'deck'): ConversionFixture {
  const root = makeDir([]);
  const pptxPath = path.join(root, `${baseName}.pptx`);
  const screenshotDir = path.join(root, 'screenshots');
  const sofficePath = path.join(root, 'soffice');
  const pdftoppmPath = path.join(root, 'pdftoppm');
  writeFileSync(pptxPath, 'pptx');
  writeFileSync(sofficePath, 'binary');
  writeFileSync(pdftoppmPath, 'binary');
  process.env.LIBREOFFICE_PATH = sofficePath;
  resolveHelperBinaryMock.mockReturnValue(pdftoppmPath);
  return { root, pptxPath, screenshotDir, pdftoppmPath };
}

function packageIndexOf(pageCount: number): unknown[] {
  return Array.from({ length: pageCount }, (_, displayIndex) => ({ displayIndex }));
}

function writePages(
  outputDir: string,
  baseName: string,
  pageNumbers: number[],
  padding = 0,
): void {
  mkdirSync(outputDir, { recursive: true });
  for (const pageNumber of pageNumbers) {
    const suffix = String(pageNumber).padStart(padding, '0');
    writeFileSync(path.join(outputDir, `${baseName}-${suffix}.jpg`), 'image');
  }
}

function installConversionExec(
  fixture: ConversionFixture,
  handlers: {
    pdftoppm: () => void;
    imageMagick?: () => void;
    qlmanage?: () => void;
  },
): void {
  execSyncMock.mockImplementation((command: string) => {
    if (command.includes('--convert-to pdf')) {
      const pdfDir = path.join(fixture.screenshotDir, '_pdf');
      mkdirSync(pdfDir, { recursive: true });
      writeFileSync(path.join(pdfDir, `${path.basename(fixture.pptxPath, '.pptx')}.pdf`), 'pdf');
      return '';
    }
    if (command.includes(' -jpeg ')) {
      handlers.pdftoppm();
      return '';
    }
    if (command.startsWith('which magick')) return '/mock/magick\n';
    if (command.includes('/mock/magick')) {
      handlers.imageMagick?.();
      return '';
    }
    if (command.startsWith('qlmanage')) {
      handlers.qlmanage?.();
      return '';
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

describe('collectPageImages — 页序定序', () => {
  it('ImageMagick 不补零的 13 页（实测文件名）按数值页码定序', () => {
    // 实测产出，故意打乱写入顺序以证明定序不是靠 readdir 巧合
    const dir = makeDir([
      'deck-10.jpg', 'deck-3.jpg', 'deck-0.jpg', 'deck-12.jpg', 'deck-7.jpg',
      'deck-1.jpg', 'deck-11.jpg', 'deck-5.jpg', 'deck-2.jpg', 'deck-9.jpg',
      'deck-4.jpg', 'deck-8.jpg', 'deck-6.jpg',
    ]);

    const got = collectPageImages(dir, 'deck').map(f => path.basename(f));

    expect(got).toEqual([
      'deck-0.jpg', 'deck-1.jpg', 'deck-2.jpg', 'deck-3.jpg', 'deck-4.jpg',
      'deck-5.jpg', 'deck-6.jpg', 'deck-7.jpg', 'deck-8.jpg', 'deck-9.jpg',
      'deck-10.jpg', 'deck-11.jpg', 'deck-12.jpg',
    ]);
    // 承重断言：错序的具体形态（10 紧跟 1）必须不出现
    expect(got.indexOf('deck-10.jpg')).toBeGreaterThan(got.indexOf('deck-9.jpg'));
  });

  it('pdftoppm 补零的 13 页（实测文件名）保持正确页序', () => {
    const dir = makeDir([
      'deck-01.jpg', 'deck-02.jpg', 'deck-03.jpg', 'deck-04.jpg', 'deck-05.jpg',
      'deck-06.jpg', 'deck-07.jpg', 'deck-08.jpg', 'deck-09.jpg', 'deck-10.jpg',
      'deck-11.jpg', 'deck-12.jpg', 'deck-13.jpg',
    ]);

    const got = collectPageImages(dir, 'deck').map(f => path.basename(f));

    expect(got[0]).toBe('deck-01.jpg');
    expect(got[9]).toBe('deck-10.jpg');
    expect(got[12]).toBe('deck-13.jpg');
  });

  it('≤10 页不触发错序（回归边界：9 页时字符串序本来就对）', () => {
    const dir = makeDir(['deck-0.jpg', 'deck-1.jpg', 'deck-2.jpg']);
    expect(collectPageImages(dir, 'deck').map(f => path.basename(f)))
      .toEqual(['deck-0.jpg', 'deck-1.jpg', 'deck-2.jpg']);
  });

  it('只收 baseName 名下的 .jpg，忽略无关文件', () => {
    const dir = makeDir([
      'deck-0.jpg', 'deck-1.jpg', 'deck-copy-2.jpg', 'decknotes-3.jpg',
      'other-0.jpg', 'deck-0.png', 'notes.txt',
    ]);
    expect(collectPageImages(dir, 'deck').map(f => path.basename(f)))
      .toEqual(['deck-0.jpg', 'deck-1.jpg']);
  });

  it('baseName 自带数字时按尾部页码定序，不被名字里的数字带偏', () => {
    const dir = makeDir(['deck2-0.jpg', 'deck2-10.jpg', 'deck2-2.jpg']);
    expect(collectPageImages(dir, 'deck2').map(f => path.basename(f)))
      .toEqual(['deck2-0.jpg', 'deck2-2.jpg', 'deck2-10.jpg']);
  });

  it('baseName 含正则元字符时仍只匹配自身页图', () => {
    const dir = makeDir([
      'deck.[v1]+-0.jpg', 'deck.[v1]+-2.jpg', 'deck.[v1]+-10.jpg',
      'deckXv11-1.jpg', 'deck.[v1]+-preview.jpg',
    ]);

    expect(collectPageImages(dir, 'deck.[v1]+').map(f => path.basename(f)))
      .toEqual(['deck.[v1]+-0.jpg', 'deck.[v1]+-2.jpg', 'deck.[v1]+-10.jpg']);
  });
});

describe('convertToScreenshots — renderer 生命周期与页数对账', () => {
  it('场景 A：入口清掉旧 13 页，新 9 页只返回本轮 9 张', async () => {
    const fixture = makeConversionFixture();
    writePages(fixture.screenshotDir, 'deck', Array.from({ length: 13 }, (_, i) => i + 1), 2);
    resolvePresentationPackageIndexMock.mockResolvedValue(packageIndexOf(9));
    installConversionExec(fixture, {
      pdftoppm: () => writePages(fixture.screenshotDir, 'deck', Array.from({ length: 9 }, (_, i) => i + 1), 2),
    });

    const got = await convertToScreenshots(fixture.pptxPath, fixture.screenshotDir);

    expect(got.map(file => path.basename(file))).toEqual(
      Array.from({ length: 9 }, (_, i) => `deck-${String(i + 1).padStart(2, '0')}.jpg`),
    );
    expect(existsSync(path.join(fixture.screenshotDir, 'deck-10.jpg'))).toBe(false);
  });

  it('场景 B：pdftoppm 半套 5 页失败后，ImageMagick 13 页不与其混排', async () => {
    const fixture = makeConversionFixture();
    resolvePresentationPackageIndexMock.mockResolvedValue(packageIndexOf(13));
    installConversionExec(fixture, {
      pdftoppm: () => {
        writePages(fixture.screenshotDir, 'deck', [1, 2, 3, 4, 5], 2);
        throw new Error('pdftoppm died after page 5');
      },
      imageMagick: () => writePages(fixture.screenshotDir, 'deck', Array.from({ length: 13 }, (_, i) => i)),
    });

    const got = await convertToScreenshots(fixture.pptxPath, fixture.screenshotDir);

    expect(got.map(file => path.basename(file))).toEqual(
      Array.from({ length: 13 }, (_, i) => `deck-${i}.jpg`),
    );
    expect(readdirSync(fixture.screenshotDir).filter(file => /^deck-\d+\.jpg$/.test(file)))
      .toHaveLength(13);
  });

  it('各 renderer 产出数都与 package index 不符时最终 fail-closed', async () => {
    const fixture = makeConversionFixture();
    resolvePresentationPackageIndexMock.mockResolvedValue(packageIndexOf(13));
    installConversionExec(fixture, {
      pdftoppm: () => writePages(fixture.screenshotDir, 'deck', [1, 2, 3, 4, 5], 2),
      imageMagick: () => writePages(fixture.screenshotDir, 'deck', [0, 1, 2, 3, 4, 5, 6, 7]),
    });

    await expect(convertToScreenshots(fixture.pptxPath, fixture.screenshotDir))
      .rejects.toThrow(/expected 13/i);
    expect(execSyncMock.mock.calls.some(([command]) => String(command).startsWith('qlmanage'))).toBe(true);
  });
});

describe('reviewPresentation — 独立临时目录生命周期', () => {
  it('截图转换抛错时也清理临时目录，不在 PPT 旁遗留默认目录', async () => {
    const fixture = makeConversionFixture();
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('ppt-visual-review-')));
    resolvePresentationPackageIndexMock.mockResolvedValue(packageIndexOf(1));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('--convert-to pdf')) throw new Error('LibreOffice crashed');
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(reviewPresentation(fixture.pptxPath, async () => '{}'))
      .rejects.toThrow(/LibreOffice conversion failed/);

    expect(existsSync(path.join(fixture.root, '_screenshots'))).toBe(false);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('ppt-visual-review-') && !before.has(name)))
      .toEqual([]);
  });
});
