import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LivePreviewDiagnosticStrip } from '../../../src/renderer/components/LivePreview/LivePreviewFrame';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// 诊断条此前把 frameError 原文（bridge 定位失败/CSP 拒绝/超时等六种工程报错
// 之一）和 CSP snippet 直接拼进可见文案。现在拆两层：固定人话摘要+建议默认
// 可见，原文和 CSP 折叠进「查看详情」——回归钉子：折叠默认收起时，原文和
// CSP 都不该出现在渲染结果里。
describe('LivePreviewDiagnosticStrip — 诊断条两层人话化', () => {
  it('默认显示人话摘要+建议，frameError 原文和 CSP snippet 默认折叠不裸露', () => {
    const rawError = 'bridge 源码定位被拒绝：ENOENT: no such file, open /repo/spike-app/src/App.tsx';
    const csp = "frame-src 'self' http://localhost:*";
    const html = renderToStaticMarkup(
      <LivePreviewDiagnosticStrip frameError={rawError} cspSnippet={csp} />,
    );

    expect(html).toContain('预览没加载出来');
    expect(html).toContain('试试刷新页面，或让 agent 重新生成一次预览。');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(rawError);
    expect(html).not.toContain(csp);
  });

  it('六种 frameError 文案任意一种都不影响第一层人话摘要（不因原文不同而改样）', () => {
    const variants = [
      'iframe 加载完成但 bridge 未报 ready —— 可能 spike-app 未装 vite-plugin-code-agent-bridge，或 bridge runtime 未注入',
      'iframe 未能加载 —— 检查：1) spike-app dev server 在否 2) Tauri CSP frame-src 是否允许 localhost 3) 端口是否正确',
      'iframe onError 触发（可能 CSP 拒绝、URL 错误、或跨域阻塞）',
    ];
    for (const variant of variants) {
      const html = renderToStaticMarkup(
        <LivePreviewDiagnosticStrip frameError={variant} cspSnippet="n/a" />,
      );
      expect(html).toContain('预览没加载出来');
      expect(html).not.toContain(variant);
    }
  });

  it('browser mode 可在诊断条内突出默认浏览器打开动作', () => {
    const html = renderToStaticMarkup(
      <LivePreviewDiagnosticStrip
        frameError="iframe onError"
        cspSnippet="n/a"
        onOpenExternal={() => {}}
      />,
    );
    expect(html).toContain('在默认浏览器打开');
    expect(html).toContain('bg-amber-300');
  });
});

// 接线钉子：只单测 LivePreviewDiagnosticStrip 本身，钉不住 LivePreviewFrame 的
// 渲染点是否真的用了它——把调用点改回裸 `⚠ {frameError}` 不会让上面的
// describe 变红。读源文件断言诊断条调用点真实形状（先例：mainTaskModelCopy.test.ts）。
describe('LivePreviewFrame 接线钉子 — 诊断条调用点真的用 LivePreviewDiagnosticStrip', () => {
  it('{/* 诊断条 */} 注释后紧跟 <LivePreviewDiagnosticStrip，不是裸 frameError 渲染', () => {
    const source = readSource('src/renderer/components/LivePreview/LivePreviewFrame.tsx');
    const marker = '{/* 诊断条 */}';
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, '找不到诊断条调用点注释，文件被改动过？').toBeGreaterThan(-1);

    const callSite = source.slice(markerIndex, markerIndex + 200);
    expect(callSite).toContain('<LivePreviewDiagnosticStrip');
    expect(callSite).not.toContain('⚠ {frameError}');
  });
});
