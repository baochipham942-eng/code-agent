// react-markdown/Prism 改为 React.lazy 懒加载后，同步的 renderToStaticMarkup 无法等待
// Suspense resolve（只会吐 fallback）。这里用 renderToPipeableStream 的 onAllReady 回调
// 等所有 Suspense 边界都 resolve 完再取字符串——比切到 jsdom + @testing-library/react 更
// 贴近原测试意图：继续跑在 vitest 默认的 node 环境下（`window` undefined），不会像 jsdom
// 那样让 resolveFileUrl 等依赖 `typeof window` 的代码路径悄悄变道。
import React from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { PassThrough } from 'node:stream';

export function renderToStaticMarkupAsync(element: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const stream = new PassThrough();
    stream.on('data', (chunk) => { html += chunk.toString(); });
    stream.on('end', () => resolve(html));
    stream.on('error', reject);
    const { pipe } = renderToPipeableStream(element, {
      onAllReady() { pipe(stream); },
      onError(err) { reject(err); },
    });
  });
}
