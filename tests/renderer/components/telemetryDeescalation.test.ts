// ============================================================================
// 工程遥测降级锚点测试（2026-07-28 品质感视觉层打磨 ③）
// 拍板：直接上屏的工程师数据（轮时间戳、已恢复 pill、组级时长）默认不上屏，
// hover（或键盘 focus-visible）才浮出；流式思考阶段只留 StreamingIndicator 的
// 扫光「正在思考…」，不再与 ThinkingDigestBanner 并存成两行静态文本。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const turnCard = readSrc('src/renderer/components/features/chat/TurnCard.tsx');
const toolStepGroup = readSrc('src/renderer/components/features/chat/ToolStepGroup.tsx');

describe('TurnCard 轮时间戳 hover 浮出', () => {
  it('卡片根是命名组 group/turncard（防嵌套 group-hover 被误触发）', () => {
    expect(turnCard).toContain('group/turncard');
  });

  it('分隔线时间戳默认 opacity-0，hover/focus 浮出', () => {
    expect(turnCard).toMatch(/text-\[10px\] text-zinc-500 shrink-0 opacity-0 transition-opacity[^\n]*group-hover\/turncard:opacity-100/);
  });
});

describe('TurnCard 思考行不重复', () => {
  it('流式思考阶段 ThinkingDigestBanner 让位给 StreamingIndicator 扫光行', () => {
    expect(turnCard).toContain('{!isThinkingPhase && <ThinkingDigestBanner');
  });
});

describe('ToolStepGroup 遥测 hover 浮出', () => {
  it('组头按钮声明 group', () => {
    expect(toolStepGroup).toMatch(/transition-colors group \$\{/);
  });

  it('「已恢复」pill 默认隐去，hover/focus-visible 浮出', () => {
    expect(toolStepGroup).toMatch(/t\.toolGroup\.recoveredTitle[\s\S]{0,200}group-hover:opacity-100 group-focus-visible:opacity-100|group-hover:opacity-100 group-focus-visible:opacity-100[\s\S]{0,200}t\.toolGroup\.recoveredTitle/);
  });

  it('组级时长默认隐去，hover/focus-visible 浮出', () => {
    expect(toolStepGroup).toMatch(/group-hover:opacity-100 group-focus-visible:opacity-100"\s*\n\s*title=\{t\.toolGroup\.durationTitle\}/);
  });
});
