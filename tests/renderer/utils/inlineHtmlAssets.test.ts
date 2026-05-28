import { describe, expect, it, vi } from 'vitest';
import { inlineHtmlAssets } from '../../../src/renderer/utils/inlineHtmlAssets';

const DIR = '/Users/x/.code-agent/work/todo-app';

const FILES: Record<string, string> = {
  [`${DIR}/style.css`]: 'body{color:red}',
  [`${DIR}/app.js`]: 'console.log("hi $1 $& done")', // 含 $ 验证不被当替换模式
};

function reader(absPath: string): Promise<string> {
  if (absPath in FILES) return Promise.resolve(FILES[absPath]);
  return Promise.reject(new Error('ENOENT ' + absPath));
}

describe('inlineHtmlAssets — Bug: 多文件产物预览丢样式/脚本', () => {
  it('inlines same-dir relative <link> and <script src> resolved against the file dir', async () => {
    const html = [
      '<head><link rel="stylesheet" href="style.css"></head>',
      '<body><script src="app.js"></script></body>',
    ].join('\n');

    const out = await inlineHtmlAssets(html, DIR, reader);

    expect(out).toContain('<style data-inlined-from="style.css">');
    expect(out).toContain('body{color:red}');
    expect(out).not.toContain('href="style.css"');
    expect(out).toContain('<script data-inlined-from="app.js">');
    expect(out).toContain('console.log("hi $1 $& done")'); // $ 原样保留
    expect(out).not.toContain('src="app.js"');
  });

  it('leaves external/absolute refs and unreadable files untouched', async () => {
    const html = [
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<link rel="stylesheet" href="/abs/site.css">',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<link rel="stylesheet" href="missing.css">',
    ].join('\n');

    const out = await inlineHtmlAssets(html, DIR, reader);

    expect(out).toContain('href="https://cdn.example.com/x.css"');
    expect(out).toContain('href="/abs/site.css"');
    expect(out).toContain('src="https://cdn.example.com/lib.js"');
    expect(out).toContain('href="missing.css"'); // 读不到 → 原样保留
  });

  it('resolves ../ relative paths against the file dir', async () => {
    const read = vi.fn().mockResolvedValue('.x{}');
    const out = await inlineHtmlAssets('<link rel="stylesheet" href="../shared/a.css">', DIR, read);
    expect(read).toHaveBeenCalledWith('/Users/x/.code-agent/work/shared/a.css');
    expect(out).toContain('<style');
  });
});
