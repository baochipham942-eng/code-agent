// ============================================================================
// pdfToImages 页序回归 — ImageMagick %d 不补零导致字符串定序错页
// ============================================================================
// 文件名取自 2026-07-14 本机实测（ImageMagick 7.1.2-27 + Ghostscript 10.06.0），
// 13 页 PDF 跑代码里那条真实命令：
//   magick -density 150 -quality 85 deck.pdf out/deck-%d.jpg
// 真实产出 deck-0.jpg..deck-12.jpg（不补零、0-based）；旧的 .sort() 字符串定序
// 把它排成 0,1,10,11,12,2,... → VLM 拿到的页序是 1,2,11,12,13,3,...
// ============================================================================

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { collectPageImages } from '../../../../../../src/host/tools/media/ppt/visualReview';

const dirs: string[] = [];

function makeDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'visual-review-page-order-'));
  dirs.push(dir);
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
    const dir = makeDir(['deck-0.jpg', 'deck-1.jpg', 'other-0.jpg', 'deck-0.png', 'notes.txt']);
    expect(collectPageImages(dir, 'deck').map(f => path.basename(f)))
      .toEqual(['deck-0.jpg', 'deck-1.jpg']);
  });

  it('baseName 自带数字时按尾部页码定序，不被名字里的数字带偏', () => {
    const dir = makeDir(['deck2-0.jpg', 'deck2-10.jpg', 'deck2-2.jpg']);
    expect(collectPageImages(dir, 'deck2').map(f => path.basename(f)))
      .toEqual(['deck2-0.jpg', 'deck2-2.jpg', 'deck2-10.jpg']);
  });
});
