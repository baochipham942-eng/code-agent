// N-L5-ECOUP 验收截图 harness：挂生产 MessageContent，一条消息塞齐代码高亮/公式/流程图/图表。
// 只读复用生产组件，零业务改动。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageContent } from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import '../../src/renderer/styles/global.css';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;

const CONTENT = [
  '## 1 · 代码高亮（本次从 Shiki 3 升到 4）',
  '',
  '```typescript',
  'interface UpgradeCheck {',
  '  name: string;',
  '  from: string;',
  '  to: string;',
  '  blocked?: boolean;',
  '}',
  '',
  'export function summarize(checks: UpgradeCheck[]): string {',
  '  const moved = checks.filter((c) => !c.blocked);',
  '  return `升级 ${moved.length} 项，卡住 ${checks.length - moved.length} 项`;',
  '}',
  '```',
  '',
  '```python',
  'def blocked_reason(pkg: str) -> str:',
  '    """katex 0.18 会让公式掉样式，因为四个下游钉在 ^0.16。"""',
  '    return f"{pkg}: downstream pinned"',
  '```',
  '',
  '## 2 · 数学公式（katex 保持 0.16.47，本次未升大版本）',
  '',
  '行内公式 $E = mc^2$，以及块公式：',
  '',
  '$$',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '$$',
  '',
  '## 3 · 流程图（mermaid 11.15 → 11.16）',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[npm outdated] --> B{major?}',
  '  B -->|minor/patch| C[直升]',
  '  B -->|major| D[逐个评估]',
  '  D --> E[三套 harness 回归门]',
  '  C --> E',
  '```',
  '',
  '## 4 · 图表（recharts 3.8 → 3.10）',
  '',
  '```chart',
  JSON.stringify({
    type: 'bar',
    title: '本次巡检处置分布',
    xKey: 'name',
    series: [{ key: 'count', name: '包数' }],
    data: [
      { name: 'minor/patch 直升', count: 6 },
      { name: 'major 升级', count: 4 },
      { name: 'major 卡上游', count: 1 },
    ],
  }, null, 2),
  '```',
  '',
  '## 5 · 表格与中文标点边界',
  '',
  '| 包 | 从 | 到 | 结论 |',
  '|---|---|---|---|',
  '| @shikijs/* | 3.23.0 | 4.4.3 | 升 |',
  '| mermaid | 11.15.0 | 11.16.1 | 升 |',
  '| katex | 0.16.27 | 0.16.47 | 升（0.18 卡上游）|',
].join('\n');

function Harness(): React.ReactElement {
  React.useEffect(() => {
    const timer = window.setTimeout(() => { document.body.dataset.ecoupReady = 'true'; }, 2500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div style={{ width: 900, padding: 24, margin: '0 auto' }}>
      <MessageContent content={CONTENT} isUser={false} messageId="ecoup-verify" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
