import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures } from './fixtures';

type Result = {
  fixtureId: string; family: string; purpose: string; chars: number;
  method: string; side: 'neo' | 'streamdown'; frameCount: number;
  terminalEqual: boolean; rawMarkdownFrames: number; rawMarkdownRatio: number;
  layoutJumpCount: number; renderMsP50: number; renderMsP95: number;
  renderMsMax: number; renderMsTotal: number; crashed: boolean;
  anomalyScreenshot: string | null;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
const data = JSON.parse(await fs.readFile(path.join(artifacts, 'results.json'), 'utf8')) as {
  metadata: Record<string, unknown>;
  fixtureLengths: Array<Record<string, unknown>>;
  results: Result[];
  semantics: Array<Record<string, unknown>>;
  consoleErrors: string[];
};
const bundle = JSON.parse(await fs.readFile(path.join(artifacts, 'bundle-size.json'), 'utf8')) as Record<string, { bytes: number; gzipBytes: number; jsChunks: number }>;
const sideName = { neo: 'Neo', streamdown: 'Streamdown' } as const;
const fixtureOrder = new Map(fixtures.map((fixture, index) => [fixture.id, index]));
const methodOrder = new Map([['random-5-30', 0], ['boundary', 1]]);
const rows = [...data.results].sort((a, b) =>
  (fixtureOrder.get(a.fixtureId)! - fixtureOrder.get(b.fixtureId)!)
  || (methodOrder.get(a.method)! - methodOrder.get(b.method)!)
  || (a.side === 'neo' ? -1 : 1),
);

function stats(side: Result['side']) {
  const selected = rows.filter((row) => row.side === side);
  return {
    runs: selected.length,
    frames: selected.reduce((sum, row) => sum + row.frameCount, 0),
    correct: selected.filter((row) => row.terminalEqual).length,
    completeSourceMismatch: selected.filter((row) => !row.terminalEqual && !row.fixtureId.startsWith('malformed-')).length,
    raw: selected.reduce((sum, row) => sum + row.rawMarkdownFrames, 0),
    jumps: selected.reduce((sum, row) => sum + row.layoutJumpCount, 0),
    p50: selected.reduce((sum, row) => sum + row.renderMsP50, 0) / selected.length,
    p95: selected.reduce((sum, row) => sum + row.renderMsP95, 0) / selected.length,
    max: Math.max(...selected.map((row) => row.renderMsMax)),
    total: selected.reduce((sum, row) => sum + row.renderMsTotal, 0),
    crashes: selected.filter((row) => row.crashed).length,
  };
}

const neo = stats('neo');
const sd = stats('streamdown');
const screenshotRoot = '/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/mdswap/artifacts/screenshots';
const resultPath = '/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/mdswap/artifacts/results.json';
const bundlePath = '/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/mdswap/artifacts/bundle-size.json';
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const kb = (value: number) => `${(value / 1024).toFixed(1)} KiB`;

const table = rows.map((row) => `| ${row.fixtureId} | ${row.method} | ${sideName[row.side]} | ${row.crashed ? '崩溃' : row.terminalEqual ? 'PASS' : 'FAIL'} | ${row.rawMarkdownFrames}/${row.frameCount} (${pct(row.rawMarkdownRatio)}) | ${row.layoutJumpCount} | ${row.renderMsP50.toFixed(1)} | ${row.renderMsP95.toFixed(1)} | ${row.renderMsMax.toFixed(1)} | ${row.renderMsTotal.toFixed(1)} |`).join('\n');

const report = `# N-L5-MDSWAP · markdown 主管线生态化对拍报告

> 日期：2026-08-17  
> 对象：Neo 自研流式 markdown 管线 vs Streamdown 2.5.0 + 官方 code/math/mermaid/cjk 插件  
> 原始数据：[results.json](${resultPath})；包体探针：[bundle-size.json](${bundlePath})

## 裁决

**建议部分切：markdown 主管线不切 Streamdown，代码渲染/高亮子层转向 Shiki 生态件做下一单。**

按“我方不赢即切”的口径，Neo 在主管线的硬门上赢了：终态一致性 40/40，Streamdown 21/40；剔除 10 个“源文本最终仍未闭合”的设计差异后，Streamdown 对完整文档仍有 9/40 失败。四类跨块引用在流式终态不回溯解析，随机切片下另有一次完整链接保持为 blocked。这个级别的丢链接、丢图片、脚注引用失联，不能用性能优势抵消。

Streamdown 的优势同样明确：长代码随机切片 p95 为 111.8ms，Neo 为 493.5ms；全轮渲染 CPU 累计 ${sd.total.toFixed(1)}ms vs ${neo.total.toFixed(1)}ms，Streamdown 约快 ${(neo.total / sd.total).toFixed(1)} 倍。主管线不换不等于继续接受这段成本，下一切片应把 Prism/代码块持续重高亮替换为 Shiki 异步高亮，保留 Neo 的 mdast 根级切块、跨引用整段回退和 CJK 边界。

## 总判定

| 指标 | Neo | Streamdown | 胜方 |
|---|---:|---:|---|
| 终态 DOM 与同库一次性整段一致 | ${neo.correct}/${neo.runs} | ${sd.correct}/${sd.runs} | Neo |
| 完整源文档终态失败 | ${neo.completeSourceMismatch} | ${sd.completeSourceMismatch} | Neo |
| 崩溃/白屏/丢整段 | ${neo.crashes} | ${sd.crashes} | 平 |
| 裸 markdown 可见帧 | ${neo.raw}/${neo.frames} | ${sd.raw}/${sd.frames} | 平 |
| 高度突变 ≥64px | ${neo.jumps} | ${sd.jumps} | Neo |
| 各 run p50 均值 | ${neo.p50.toFixed(1)}ms | ${sd.p50.toFixed(1)}ms | Streamdown |
| 各 run p95 均值 | ${neo.p95.toFixed(1)}ms | ${sd.p95.toFixed(1)}ms | Streamdown |
| 最长单帧 | ${neo.max.toFixed(1)}ms | ${sd.max.toFixed(1)}ms | Streamdown |
| 全轮渲染 CPU 累计 | ${neo.total.toFixed(1)}ms | ${sd.total.toFixed(1)}ms | Streamdown |

## 关键证据

1. **跨块引用是主管线否决项。** Neo 的 containsCrossBlockReference 会退回整段可变尾块，4 条引用 fixture × 2 切法全部 PASS。Streamdown 8/8 FAIL；人眼抽查中 link definition 的终态 href 为 null。  
   ![Streamdown 跨块引用终态未生成链接](${screenshotRoot}/semantic-reference-link-definition-streamdown.png)
2. **切片方式会改变 Streamdown 终态。** long-mixed-code 的完整显式链接，boundary PASS，random-5-30 FAIL，终态保留 blocked link；同一文本因 chunk 边界得到不同 DOM。
3. **中间态裸符号打平。** 两侧都是 7/1136 帧，全部来自半表格/中断列表和长文随机切片；Streamdown 没在该指标领先。
4. **Streamdown 布局突变更多。** 18 次 vs Neo 5 次，主要来自半表格和长代码块控件/高亮结构变化。
5. **Streamdown 长代码性能显著领先。** 7.5KB、112 行代码 fixture：random p95 111.8ms vs 493.5ms；boundary p95 81.8ms vs 302.9ms。Neo 的 CodeBlock 在流式早期以短块挂载，跨过 25 行后按现有设计不自动折叠，并持续推进 Prism 分块高亮，是主要成本。
6. **官方图片组件存在 DOM 合法性警告。** one-shot imageReference 能出 1 个 img/1 个 wrapper，但 React 报 \`<div> cannot be a descendant of <p>\`，可能引发 hydration 问题。  
   ![Streamdown one-shot 图片结构](${screenshotRoot}/semantic-reference-image-definition-streamdown.png)

### 语义抽查

| 用例 | 侧 | 检查 | 结果 |
|---|---|---|---|
| ragged table | Neo | 表格结构 | 1 table / 4 rows，符合输入 |
| unclosed fence | Streamdown | 代码块完整性 | 1 pre，代码文本完整 |
| CJK comma URL | Neo | href | https://example.com |
| CJK comma URL | Streamdown+CJK | href | https://example.com/，语义等价 |
| link reference | Streamdown 流式终态 | href | null，FAIL |
| image reference | Streamdown one-shot | 图片 DOM | 1 img / 1 wrapper，同时触发非法 p>div 警告 |

## 迁移成本清单

| Neo 定制 | Streamdown 承接 | 结论 | 估算 |
|---|---|---|---:|
| remarkTrimCjkAutolink | \`remarkPlugins\` 直接传；官方 \`@streamdown/cjk\` 在 6 条 CJK fixture 全过 | 现成支持 | 3–8 行接线；可优先用官方 CJK |
| urlTransform + neo:// | 暴露 \`urlTransform(url,key,node)\`；可复用默认 transform 后放行 scheme | 现成支持 | 5–10 行 |
| mermaid/chart/generative_ui 标签路由 | mermaid 官方插件；\`plugins.renderers\` 支持 language→component；复杂 UI 也可覆写 \`components.code\` | 要写胶水 | 45–80 行；generative_ui/neo_ui 还需闭包注入 message/session/ordinal |
| 文件路径 InlineCode 可点击 | 有独立 \`components.inlineCode\` | 现成支持 | 10–20 行复用现组件 |
| 代码复制/换行/超阈值折叠 | 复制、下载、行号现成；没有 Neo 的换行 toggle 和 25 行折叠 | 要写胶水 | 80–140 行；直接复用 CodeBlock 会放弃内建 Shiki 控件组合 |
| i18n 文案注入 | \`translations: Partial<StreamdownTranslations>\` 支持官方控件文案 | 现成支持 | 10–25 行；Neo 自定义折叠/换行仍走现有 i18n |
| Prism→Shiki 随 data-theme | \`createCodePlugin({themes:[light,dark]})\`；Neo 已同步 html 的 dark/light class | 要写胶水 | 20–40 行；高对比主题需自定义 Shiki theme/切换策略 |
| 跨块引用 | 可覆写 \`parseMarkdownIntoBlocksFn\`，但默认实现实测终态失败 | 要写胶水 | 20–40 行；检测 reference 后强制单块，复用 Neo 策略 |
| 包体积增量 | 官方插件可 tree-shake/懒加载，但全套显著大于 core | 要控制懒加载 | 见下 |

迁移胶水合计约 **193–363 行**，不含现有 Mermaid/Chart/GenerativeUI 组件本体。

### 包体探针

| 隔离入口 | minified JS | gzip（逐 chunk 合计） | chunk 数 |
|---|---:|---:|---:|
| Neo 当前真实 MarkdownRenderer 入口 | ${kb(bundle.neo.bytes)} | ${kb(bundle.neo.gzipBytes)} | ${bundle.neo.jsChunks} |
| Streamdown core | ${kb(bundle['streamdown-core'].bytes)} | ${kb(bundle['streamdown-core'].gzipBytes)} | ${bundle['streamdown-core'].jsChunks} |
| Streamdown + code/math/mermaid/cjk | ${kb(bundle['streamdown-full'].bytes)} | ${kb(bundle['streamdown-full'].gzipBytes)} | ${bundle['streamdown-full'].jsChunks} |

隔离探针显示全套 Streamdown 比 Neo 当前入口多约 ${kb(bundle['streamdown-full'].gzipBytes - bundle.neo.gzipBytes)} gzip。该数字是替代入口上界，不可直接当生产首屏增量：Neo 已有 KaTeX/Mermaid，且两侧都应保持动态 import。真正迁移前必须在生产 renderer 上做 fresh build 的 chunk diff，验收要求是首屏 modulepreload 不新增 Shiki/Mermaid/KaTeX。

本次 harness 的 Vite production build 还给出确定性警告：\`@streamdown/mermaid\` 静态 import \`mermaid.core.mjs\`，使 Neo \`mermaidLoader.ts\` 的动态 import 失效。若照全套配置直接接入，Mermaid 会被钉进入口依赖图；迁移实现必须把 Streamdown mermaid plugin 自身也放进动态边界，不能只依赖包的 tree-shaking 声明。

## 全量对拍表

终态只 normalize 空白、动态 style/id 和属性顺序；语义属性保留。布局跳变定义为相邻 150ms 快照高度差绝对值 ≥64px。render 时间覆盖状态更新、React commit 和两个 rAF，不含剩余 cadence 等待。

| fixture | 切法 | 侧 | 终态 | 裸符号帧 | 布局跳变 | p50 ms | p95 ms | max ms | 渲染累计 ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${table}

## 复现

\`\`\`bash
cd /Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap
npm ci
npx tsx tests/eval/mdswap/run.ts
npx tsx tests/eval/mdswap/bundle-size.ts
node scripts/tsc-tests-ratchet.mjs
node scripts/eslint-ratchet.mjs
node scripts/knip-ratchet.mjs --profile production
\`\`\`

固定 seed：\`${data.metadata.seed}\`；Chromium：\`${data.metadata.userAgent}\`；真实节拍：每次 tick 起点至少间隔 150ms。两侧按 fixture/切法交替先后顺序，消除固定热身偏差。官方能力核对来源：[Streamdown 官方文档](https://streamdown.ai) 与本次安装的 2.5.0 包内 types。

### 本次验证门

| 验证 | 结果 |
|---|---|
| 相关 Vitest（streamingMarkdownBlocks / CJK autolink / messageContent streaming） | PASS，3 文件 / 33 tests |
| tests TypeScript ratchet | PASS，current 0 / baseline 0 |
| ESLint ratchet | PASS，errors 0 / warnings 414，与 baseline 持平 |
| production Knip ratchet | PASS，issues 3875 ≤ 3904；unreachable 125 ≤ 130 |
| harness Vite production build | PASS，5543 modules transformed |

Vite build 的 Mermaid 静态导入警告已作为包体风险计入裁决，不影响 harness 产物生成。

## 决策后的验证路径

- **P0：代码层生态化 spike。** 保留 Neo splitter/remend/reference fallback，只替换 CodeBlock 高亮内核。验收：20 fixture 终态继续 40/40；长代码 p95 ≤170ms、max ≤200ms；布局跳变不高于 5；生产首屏 preload 不增。
- **P1：跟进 Streamdown 完整源终态缺陷。** 用本 fixture 向上游验证跨块 reference、random chunk blocked link、p>div 图片 wrapper。只有完整源 40/40 且 console 无结构警告，才重新打开主管线迁移决策。
- **P2：生产 bundle 与主题真机验收。** fresh origin/main 构建，四套 data-theme、复制/换行/折叠、mermaid/chart/generative_ui、neo://、文件路径点击逐项验收。

## 限制

- 对拍页复用了真实 MarkdownRenderer、MarkdownCore、CodeBlock、InlineCode；没有接 smooth streaming、TurnCard、错误分级，符合范围。
- Streamdown 使用当前官方四插件等价配置；不装插件会得到更小更快但功能不等价的结果。
- 高度阈值是可复查的启发式，不等同于视觉 diff；截图用于人眼复核。
- bundle 是隔离入口探针，生产增量要在实施单 fresh build 后裁定。
`;

await fs.writeFile(path.join(artifacts, 'report.md'), report);
console.log(path.join(artifacts, 'report.md'));
